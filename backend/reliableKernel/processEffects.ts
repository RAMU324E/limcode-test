import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { RootBinding } from './contracts';
import {
  ContentAddressedStore,
  type ContentObjectMetadata,
  type PreparedContentObject
} from './contentAddressedStore';
import {
  EffectControlPlane,
  matchesExpectedUnique,
  preparedContentSteps,
  stablePhaseDId,
  type PhaseDCommandSource,
  type PreparedEffectIntent,
  type ToolTerminalResult
} from './effectControlPlane';
import {
  PROCESS_OUTPUT_MAX_CHUNK_BYTES,
  PROCESS_OUTPUT_MAX_RETAINED_BYTES,
  PROCESS_OUTPUT_MAX_RETAINED_CHUNKS,
  PROCESS_OUTPUT_MAX_TERMINAL_TAIL_BYTES_PER_STREAM,
  PROCESS_WRAPPER_CHUNKS_DIRECTORY,
  PROCESS_WRAPPER_EXIT_RECEIPT_FILE,
  PROCESS_WRAPPER_IDENTITY_FILE,
  PROCESS_WRAPPER_MANIFEST_FILE,
  PROCESS_WRAPPER_PROTOCOL,
  PROCESS_WRAPPER_STOP_REQUEST_FILE,
  isLinuxWrapperProcessReachable,
  listProcessSpoolChunks,
  parseStopRequest,
  parseWrapperExitReceipt,
  parseWrapperIdentity,
  parseWrapperManifest,
  processSpoolPath,
  processSpoolRoot,
  readLinuxStartFingerprint,
  type ProcessStopRequest,
  type ProcessWrapperExitReceipt,
  type ProcessWrapperIdentity,
  type ProcessWrapperLaunchRequest,
  type ProcessWrapperManifest
} from './processProtocol';
import { DOMAIN_REPOSITORIES, type DomainRow, type RepositoryTransactionStep } from './repositories';
import { RootAuthority } from './rootAuthority';
import { RuntimeDatabase } from './runtimeDatabase';

export interface ProcessStartRequest {
  processId: string;
  stableNonce: string;
  command: string;
  cwd: string;
  commandDigest: string;
  spoolLocator: string;
}

export interface ProcessStopEffectRequest {
  processId: string;
  stableNonce: string;
  startFingerprint: string;
  processGroupId: string;
  commandDigest: string;
  spoolLocator: string;
}

export interface ProcessExitEffectRequest extends ProcessStopEffectRequest {
  wrapperPid: string;
  childPid: string;
}

export interface ProcessStartPreparation {
  effect: PreparedEffectIntent;
  request: ProcessStartRequest;
}

export type ProcessLaunchObservation =
  | { outcome: 'succeeded'; identity: ProcessWrapperIdentity }
  | { outcome: 'failed'; error: string }
  | { outcome: 'outcome_unknown'; error: string };

export interface ProcessStartObservation {
  outcome: 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
  launch: ProcessLaunchObservation;
  foreground: ProcessWaitObservation | null;
}

export interface ProcessOutputReadResult {
  processId: string;
  status: string;
  stdout: Buffer;
  stderr: Buffer;
  retainedBytes: string;
  retainedChunks: string;
  droppedBytes: string;
  truncated: boolean;
}

export type ProcessWaitObservation =
  | { state: 'running'; processId: string }
  | { state: 'exited'; processId: string; receipt: ProcessWrapperExitReceipt }
  | { state: 'outcome_unknown'; processId: string; reason: string };

interface ReconciledOutput {
  retainedBytes: bigint;
  retainedChunks: bigint;
  droppedBytes: bigint;
  truncated: boolean;
  insertedChunks: number;
}

interface ProcessOutputSnapshot {
  processRow: DomainRow;
  registered: DomainRow[];
}

interface VerifiedSpoolPrefix {
  manifest: ProcessWrapperManifest;
  chunks: ReturnType<typeof listProcessSpoolChunks>;
}

interface ProcessOutputCounters {
  retainedBytes: bigint;
  retainedChunks: bigint;
  droppedBytes: bigint;
  truncated: boolean;
}

const PROCESS_START = 'process_start' as const;
const PROCESS_STOP = 'process_stop_request' as const;
const WRAPPER_IDENTITY_WAIT_MS = 5_000;
const WRAPPER_IDENTITY_POLL_MS = 20;

/** Process domain orchestration; the detached wrapper remains the external process authority. */
export class ProcessControlPlane {
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    private readonly contentStore: ContentAddressedStore,
    private readonly effects: EffectControlPlane,
    private readonly authority: RootAuthority,
    private readonly binding: RootBinding,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async prepareStart(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    command: string;
    cwd: string;
  }): Promise<ProcessStartPreparation> {
    const toolCallId = requireId(input.toolCallId, 'toolCallId');
    const command = requireText(input.command, 'command');
    const cwd = path.resolve(requireText(input.cwd, 'cwd'));
    const processId = stablePhaseDId('process', toolCallId);
    const request: ProcessStartRequest = {
      processId,
      stableNonce: randomBytes(16).toString('hex'),
      command,
      cwd,
      commandDigest: commandDigest(command, cwd),
      spoolLocator: processId
    };
    const effect = await this.effects.prepareEffectIntent({
      source: input.source,
      toolCallId,
      effectKind: PROCESS_START,
      request
    });
    // Duplicate source replay must return the first committed stable nonce/request.
    return {
      effect,
      request: await this.effects.readEffectRequest<ProcessStartRequest>(effect.effectIntentId)
    };
  }

  public async dispatchStart(effectIntentIdInput: string, foregroundWaitMs = 0): Promise<{
    observation: ProcessStartObservation | null;
    terminal: ToolTerminalResult | null;
  }> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    requireWaitDuration(foregroundWaitMs);
    if (!await this.effects.claimEffectDispatch(effectIntentId)) return { observation: null, terminal: null };
    const launch = await this.launchDispatched(effectIntentId);
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    const request = normalizeStartRequest(await this.effects.readEffectRequest<ProcessStartRequest>(effectIntentId));
    const observation = await this.observeStart(request, launch, foregroundWaitMs);
    const recorded = await this.effects.recordEffectReceipt({
      source: { kind: 'callback', key: `process-start:${String(intent.attempt_id)}:receipt` },
      attemptId: intent.attempt_id as string,
      effectKind: PROCESS_START,
      outcome: observation.outcome,
      detail: observation
    });
    return {
      observation,
      terminal: await this.reconcileStartReceipt(recorded.effectReceiptId)
    };
  }

  /** Launches only an already-dispatched intent; useful after the durable claim, never for retry. */
  public async launchDispatched(effectIntentIdInput: string): Promise<ProcessLaunchObservation> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    await this.validateBinding();
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    if (intent.effect_kind !== PROCESS_START || intent.dispatch_state !== 'dispatched') {
      throw new Error('Process launch requires a committed dispatched process_start EffectIntent.');
    }
    if ((await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 1)).length > 0) {
      throw new Error('process_start EffectIntent already has a Receipt and cannot launch again.');
    }
    const request = normalizeStartRequest(await this.effects.readEffectRequest<ProcessStartRequest>(effectIntentId));
    const spoolPath = processSpoolPath(this.binding, request.spoolLocator);
    try {
      await fs.mkdir(processSpoolRoot(this.binding), { recursive: true });
      await fs.mkdir(spoolPath, { recursive: false });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { outcome: 'outcome_unknown', error: 'Process spool already exists; automatic redispatch is forbidden.' };
      }
      return { outcome: 'failed', error: errorMessage(error) };
    }
    const launch: ProcessWrapperLaunchRequest = {
      kind: PROCESS_WRAPPER_PROTOCOL,
      ...request,
      createdAt: this.timestamp()
    };
    const launchPath = path.join(spoolPath, 'launch.json');
    await writeAtomicJson(launchPath, launch);
    const spawned = await new Promise<{ ok: true } | { ok: false; error: unknown }>((resolve) => {
      try {
        const wrapper = spawn(process.execPath, [path.join(__dirname, 'processWrapper.js'), launchPath], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
        const onError = (error: Error) => resolve({ ok: false, error });
        wrapper.once('error', onError);
        wrapper.once('spawn', () => {
          wrapper.off('error', onError);
          wrapper.on('error', (error) => {
            console.warn('[reliable-kernel] detached process wrapper error:', errorMessage(error));
          });
          wrapper.unref();
          resolve({ ok: true });
        });
      } catch (error) {
        resolve({ ok: false, error });
      }
    });
    if (!spawned.ok) return { outcome: 'failed', error: errorMessage(spawned.error) };
    return waitForLaunchEvidence(request, spoolPath, launch.createdAt, WRAPPER_IDENTITY_WAIT_MS);
  }

  public async reconcileStartReceipt(effectReceiptIdInput: string): Promise<ToolTerminalResult | null> {
    const effectReceiptId = requireId(effectReceiptIdInput, 'effectReceiptId');
    const receipt = await this.requireExisting('EffectReceipt', effectReceiptId);
    if (receipt.effect_kind !== PROCESS_START) throw new Error('EffectReceipt is not process_start.');
    const attempt = await this.requireExisting('Attempt', requireId(receipt.attempt_id, 'EffectReceipt.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    const toolCallId = requireId(operation.tool_call_id, 'Operation.tool_call_id');
    const intentRows = await this.list('EffectIntent', { attempt_id: attempt.id }, 2);
    if (intentRows.length !== 1) throw new Error('process_start Attempt must have one EffectIntent.');
    const request = normalizeStartRequest(await this.effects.readEffectRequest<ProcessStartRequest>(intentRows[0].id as string));
    const source: PhaseDCommandSource = { kind: 'internal', key: `process-start-reconcile:${effectReceiptId}` };
    const outcome = requireProcessStartOutcome(receipt.outcome);
    const rawObservation = await this.readReceiptDetail<unknown>(receipt);
    const observation = normalizeProcessStartObservation(rawObservation, request);
    if (observation.outcome !== outcome) throw new Error('process_start Receipt detail outcome mismatch.');

    const existingProcess = await this.maybeGet('Process', request.processId);
    const additionalSteps: RepositoryTransactionStep[] = [];
    let exitRequestContent: PreparedContentObject | undefined;
    if (observation.launch.outcome === 'succeeded') {
      assertIdentityMatchesStart(observation.launch.identity, request);
      if (!observation.foreground) throw new Error('Succeeded process launch lacks foreground observation.');
      if (existingProcess) {
        assertProcessMatchesIdentity(existingProcess, observation.launch.identity);
      } else {
        if (observation.foreground.state === 'running') {
          exitRequestContent = await this.contentStore.prepare(
            this.database,
            Buffer.from(JSON.stringify(processExitRequest(observation.launch.identity)), 'utf8'),
            'application/vnd.limcode.effect-process_exit+json'
          );
        }
        additionalSteps.push(...processStartFactSteps(
          request,
          toolCallId,
          observation.launch.identity,
          observation.foreground,
          this.timestamp(),
          exitRequestContent
        ));
      }
    } else if (existingProcess) {
      throw new Error('Failed/unknown process launch cannot already own a Process row.');
    }
    return this.effects.completeOperation({
      source,
      effectReceiptId,
      outcome,
      ...(additionalSteps.length > 0 ? { additionalSteps } : {})
    });
  }

  public async prepareStop(input: {
    source: PhaseDCommandSource;
    toolCallId: string;
    processId: string;
  }): Promise<PreparedEffectIntent> {
    const processRow = await this.requireExisting('Process', requireId(input.processId, 'processId'));
    const request: ProcessStopEffectRequest = {
      processId: processRow.id as string,
      stableNonce: requireText(processRow.wrapper_nonce, 'Process.wrapper_nonce'),
      startFingerprint: requireText(processRow.start_fingerprint, 'Process.start_fingerprint'),
      processGroupId: requireBigInt(processRow.process_group_id, 'Process.process_group_id').toString(),
      commandDigest: requireSha256(processRow.command_digest, 'Process.command_digest'),
      spoolLocator: requireText(processRow.spool_locator, 'Process.spool_locator')
    };
    return this.effects.prepareEffectIntent({
      source: input.source,
      toolCallId: input.toolCallId,
      effectKind: PROCESS_STOP,
      request,
      owner: { kind: 'process', id: request.processId }
    });
  }

  public async dispatchStop(effectIntentIdInput: string): Promise<{
    outcome: 'succeeded' | 'outcome_unknown';
    terminal: ToolTerminalResult | null;
  } | null> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    if (!await this.effects.claimEffectDispatch(effectIntentId)) return null;
    const outcome = await this.executeDispatchedStop(effectIntentId);
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    const recorded = await this.effects.recordEffectReceipt({
      source: { kind: 'callback', key: `process-stop:${String(intent.attempt_id)}:receipt` },
      attemptId: intent.attempt_id as string,
      effectKind: PROCESS_STOP,
      outcome: outcome.outcome,
      detail: outcome
    });
    const persisted = await this.requireExisting('EffectReceipt', recorded.effectReceiptId);
    const persistedOutcome = requireProcessStopOutcome(persisted.outcome);
    return {
      outcome: persistedOutcome,
      terminal: await this.effects.completeOperation({
        source: { kind: 'internal', key: `process-stop-reconcile:${recorded.effectReceiptId}` },
        effectReceiptId: recorded.effectReceiptId,
        outcome: persistedOutcome
      })
    };
  }

  /** Writes a request for the wrapper; the Extension Host never signals a bare PID/process group. */
  public async executeDispatchedStop(effectIntentIdInput: string): Promise<{ outcome: 'succeeded' | 'outcome_unknown'; reason?: string }> {
    const effectIntentId = requireId(effectIntentIdInput, 'effectIntentId');
    await this.validateBinding();
    const intent = await this.requireExisting('EffectIntent', effectIntentId);
    if (intent.effect_kind !== PROCESS_STOP || intent.dispatch_state !== 'dispatched') {
      throw new Error('Process stop requires a committed dispatched process_stop_request EffectIntent.');
    }
    const request = normalizeStopRequest(await this.effects.readEffectRequest<ProcessStopEffectRequest>(effectIntentId));
    const processRow = await this.requireExisting('Process', request.processId);
    if (!processEvidenceMatches(processRow, request)) {
      return { outcome: 'outcome_unknown', reason: 'Persisted Process evidence does not match stop request.' };
    }
    const spoolPath = processSpoolPath(this.binding, request.spoolLocator);
    let identity: ProcessWrapperIdentity;
    try {
      identity = parseWrapperIdentity(await readJson(path.join(spoolPath, PROCESS_WRAPPER_IDENTITY_FILE)));
      assertIdentityMatchesStop(identity, request);
      if (!isLinuxWrapperProcessReachable(identity.wrapperPid, path.join(spoolPath, 'launch.json'))) {
        return { outcome: 'outcome_unknown', reason: 'Recorded process wrapper is not reachable.' };
      }
      if (readLinuxStartFingerprint(identity.childPid) !== identity.startFingerprint) {
        return { outcome: 'outcome_unknown', reason: 'Live process start fingerprint does not match.' };
      }
    } catch (error) {
      return { outcome: 'outcome_unknown', reason: errorMessage(error) };
    }
    const stop: ProcessStopRequest = {
      kind: PROCESS_WRAPPER_PROTOCOL,
      processId: request.processId,
      stableNonce: request.stableNonce,
      startFingerprint: request.startFingerprint,
      processGroupId: request.processGroupId,
      commandDigest: request.commandDigest,
      requestedAt: this.timestamp()
    };
    await writeAtomicJson(path.join(spoolPath, PROCESS_WRAPPER_STOP_REQUEST_FILE), stop);
    return { outcome: 'succeeded' };
  }

  /** Recovery reads existing stop evidence and never writes or re-dispatches the stop request. */
  public async recoverDispatchedStop(input: {
    source: PhaseDCommandSource;
    effectIntentId: string;
  }): Promise<ToolTerminalResult | null> {
    if (input.source.kind !== 'recovery') throw new TypeError('Process stop recovery requires recovery source kind.');
    const intent = await this.requireExisting('EffectIntent', requireId(input.effectIntentId, 'effectIntentId'));
    if (intent.effect_kind !== PROCESS_STOP) throw new Error('Recovery target must be process_stop_request.');
    const existing = (await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 2))[0];
    if (existing) {
      return this.effects.completeOperation({
        source: { kind: 'recovery', key: `process-stop-reconcile:${String(existing.id)}` },
        effectReceiptId: existing.id as string,
        outcome: requireProcessStopOutcome(existing.outcome)
      });
    }
    if (intent.dispatch_state !== 'dispatched') {
      throw new Error('Process stop recovery without a Receipt requires a dispatched EffectIntent.');
    }
    await this.validateBinding();
    const request = normalizeStopRequest(await this.effects.readEffectRequest<ProcessStopEffectRequest>(intent.id as string));
    const processRow = await this.requireExisting('Process', request.processId);
    let outcome: 'succeeded' | 'outcome_unknown' = 'outcome_unknown';
    let reason = 'Persisted stop request evidence could not be proved.';
    try {
      if (!processEvidenceMatches(processRow, request)) throw new Error('Persisted Process does not match stop request.');
      const spoolPath = processSpoolPath(this.binding, request.spoolLocator);
      const persisted = parseStopRequest(await readJson(path.join(spoolPath, PROCESS_WRAPPER_STOP_REQUEST_FILE)));
      assertStopRequestMatchesEffect(request, persisted);
      outcome = 'succeeded';
      reason = 'Matching atomic process stop request exists.';
    } catch (error) {
      reason = errorMessage(error);
    }
    const recorded = await this.effects.recordEffectReceipt({
      source: input.source,
      attemptId: intent.attempt_id as string,
      effectKind: PROCESS_STOP,
      outcome,
      detail: { outcome, reason, automaticRetry: false }
    });
    const winner = await this.requireExisting('EffectReceipt', recorded.effectReceiptId);
    return this.effects.completeOperation({
      source: { kind: 'recovery', key: `process-stop-reconcile:${recorded.effectReceiptId}` },
      effectReceiptId: recorded.effectReceiptId,
      outcome: requireProcessStopOutcome(winner.outcome)
    });
  }

  /** Imports one immutable wrapper-manifest prefix into CAS+SQLite; it never re-runs the process. */
  public async reconcileOutput(processIdInput: string): Promise<ReconciledOutput> {
    const processId = requireId(processIdInput, 'processId');
    await this.validateBinding();
    const { processRow, registered } = await this.readProcessOutputSnapshot(processId);
    const spoolPath = processSpoolPath(this.binding, requireText(processRow.spool_locator, 'Process.spool_locator'));
    const { manifest, chunks } = await this.readVerifiedSpoolPrefix(processRow, spoolPath);
    const counters = outputCounters(manifest);
    assertProcessOutputProgress(processRow, counters, manifest.status);

    const existingSeq = new Set(registered.map((row) => requireBigInt(
      row.chunk_seq,
      'ProcessOutputChunk.chunk_seq'
    ).toString()));
    const existingBytes = registered.reduce(
      (total, row) => total + requireBigInt(row.byte_length, 'ProcessOutputChunk.byte_length'),
      0n
    );
    const unregistered = chunks.filter((chunk) => !existingSeq.has(chunk.chunkSeq));
    const representedChunks = BigInt(registered.length + unregistered.length);
    const representedBytes = existingBytes + unregistered.reduce(
      (total, chunk) => total + BigInt(chunk.byteLength),
      0n
    );
    assertOutputCoverage(representedBytes, representedChunks, counters.retainedBytes, counters.retainedChunks);

    const prepared: Array<{
      chunk: typeof chunks[number];
      content: Awaited<ReturnType<ContentAddressedStore['prepare']>>;
      createdAt: string;
    }> = [];
    for (const chunk of unregistered) {
      const bytes = await fs.readFile(chunk.path);
      if (bytes.byteLength > PROCESS_OUTPUT_MAX_CHUNK_BYTES || String(bytes.byteLength) !== chunk.byteLength) {
        throw new Error(`Invalid process spool chunk ${chunk.chunkSeq}.`);
      }
      const stat = await fs.stat(chunk.path);
      prepared.push({
        chunk,
        content: await this.contentStore.prepare(this.database, bytes, 'application/octet-stream'),
        createdAt: stat.mtime.toISOString()
      });
    }

    const countersChanged = !processCountersEqual(processRow, counters);
    if (prepared.length > 0 || countersChanged) {
      const steps: RepositoryTransactionStep[] = [];
      if (countersChanged) {
        steps.push(DOMAIN_REPOSITORIES.domain('Process').assert(processId, {
          status: processRow.status,
          retained_bytes: processRow.retained_bytes,
          retained_chunks: processRow.retained_chunks,
          dropped_bytes: processRow.dropped_bytes,
          truncated: processRow.truncated
        }));
      }
      for (const entry of prepared) {
        steps.push(
          ...preparedContentSteps([entry.content], `process_chunk_${entry.chunk.chunkSeq}`),
          DOMAIN_REPOSITORIES.domain('ProcessOutputChunk').insert({
            id: stablePhaseDId('process_output_chunk', `${processId}:${entry.chunk.chunkSeq}`),
            process_id: processId,
            chunk_seq: entry.chunk.chunkSeq,
            stream_kind: entry.chunk.streamKind,
            content_object_id: entry.content.metadata.id,
            byte_length: entry.chunk.byteLength,
            created_at: entry.createdAt
          })
        );
      }
      if (countersChanged) {
        steps.push(DOMAIN_REPOSITORIES.domain('Process').update(processId, {
          retained_bytes: counters.retainedBytes.toString(),
          retained_chunks: counters.retainedChunks.toString(),
          dropped_bytes: counters.droppedBytes.toString(),
          truncated: counters.truncated ? '1' : '0',
          updated_at: this.timestamp()
        }));
      }
      try {
        await this.database.transaction(steps);
      } catch (error) {
        if (
          !isTransactionAssertionFailure(error)
          && !matchesExpectedUnique(error, [
            ['process_output_chunk', ['id']],
            ['process_output_chunk', ['process_id', 'chunk_seq']]
          ])
        ) throw error;
        return this.currentReconciledOutput(processId);
      }
    }
    return {
      retainedBytes: counters.retainedBytes,
      retainedChunks: counters.retainedChunks,
      droppedBytes: counters.droppedBytes,
      truncated: counters.truncated,
      insertedChunks: prepared.length
    };
  }

  /** Pure, repeatable read. SQLite/CAS is authoritative; verified spool only supplies a missing prefix/live tail. */
  public async readOutput(processIdInput: string): Promise<ProcessOutputReadResult> {
    const processId = requireId(processIdInput, 'processId');
    await this.validateBinding();
    const { processRow, registered } = await this.readProcessOutputSnapshot(processId);
    const entries: Array<{ chunkSeq: bigint; streamKind: 'stdout' | 'stderr'; bytes: Buffer }> = [];
    const registeredSeq = new Set<string>();
    let registeredBytes = 0n;
    for (const row of registered) {
      const chunkSeq = requireBigInt(row.chunk_seq, 'ProcessOutputChunk.chunk_seq');
      const streamKind = requireStreamKind(row.stream_kind);
      const metadata = await this.requireExisting(
        'ContentObject',
        requireId(row.content_object_id, 'ProcessOutputChunk.content_object_id')
      ) as ContentObjectMetadata;
      const bytes = await this.contentStore.read(metadata);
      const byteLength = requireBigInt(row.byte_length, 'ProcessOutputChunk.byte_length');
      if (BigInt(bytes.byteLength) !== byteLength) {
        throw new Error(`ProcessOutputChunk ${String(row.id)} CAS length mismatch.`);
      }
      registeredBytes += byteLength;
      registeredSeq.add(chunkSeq.toString());
      entries.push({ chunkSeq, streamKind, bytes });
    }

    const persisted = processRowOutputCounters(processRow);
    if (registeredBytes > persisted.retainedBytes || BigInt(registered.length) > persisted.retainedChunks) {
      throw new Error('Registered ProcessOutputChunk rows exceed persisted Process counters.');
    }

    const spoolPath = processSpoolPath(this.binding, requireText(processRow.spool_locator, 'Process.spool_locator'));
    let formal = persisted;
    let stableManifest: ProcessWrapperManifest | undefined;
    try {
      const prefix = await this.readVerifiedSpoolPrefix(processRow, spoolPath);
      const spoolCounters = outputCounters(prefix.manifest);
      assertProcessOutputProgress(processRow, spoolCounters, prefix.manifest.status);
      const missing = prefix.chunks.filter((chunk) => !registeredSeq.has(chunk.chunkSeq));
      let missingBytes = 0n;
      for (const chunk of missing) {
        const bytes = await fs.readFile(chunk.path);
        if (String(bytes.byteLength) !== chunk.byteLength) {
          throw new Error(`Invalid process spool chunk ${chunk.chunkSeq}.`);
        }
        missingBytes += BigInt(bytes.byteLength);
        entries.push({ chunkSeq: BigInt(chunk.chunkSeq), streamKind: chunk.streamKind, bytes });
      }
      assertOutputCoverage(
        registeredBytes + missingBytes,
        BigInt(registered.length + missing.length),
        spoolCounters.retainedBytes,
        spoolCounters.retainedChunks
      );
      formal = spoolCounters;
      stableManifest = prefix.manifest;
    } catch (error) {
      const casComplete = registeredBytes === persisted.retainedBytes
        && BigInt(registered.length) === persisted.retainedChunks;
      if (!casComplete) {
        throw new Error(`Process output integrity check failed: ${errorMessage(error)}`);
      }
    }

    entries.sort((left, right) => left.chunkSeq < right.chunkSeq ? -1 : left.chunkSeq > right.chunkSeq ? 1 : 0);
    const stdout = entries.filter((entry) => entry.streamKind === 'stdout').map((entry) => entry.bytes);
    const stderr = entries.filter((entry) => entry.streamKind === 'stderr').map((entry) => entry.bytes);
    let liveBytes = 0n;
    let liveChunks = 0n;
    if (stableManifest?.status === 'running') {
      const live = await this.readStableLiveTails(spoolPath, processRow, stableManifest);
      if (live) {
        if (live.stdout.length > 0) {
          stdout.push(live.stdout);
          liveBytes += BigInt(live.stdout.length);
          liveChunks += 1n;
        }
        if (live.stderr.length > 0) {
          stderr.push(live.stderr);
          liveBytes += BigInt(live.stderr.length);
          liveChunks += 1n;
        }
      }
    }
    const effectiveBytes = formal.retainedBytes + liveBytes;
    const effectiveChunks = formal.retainedChunks + liveChunks;
    assertOutputBounds(effectiveBytes, effectiveChunks);
    return {
      processId,
      status: String(processRow.status),
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
      retainedBytes: effectiveBytes.toString(),
      retainedChunks: effectiveChunks.toString(),
      droppedBytes: formal.droppedBytes.toString(),
      truncated: formal.truncated
    };
  }

  /** Observes wrapper evidence only. A local timeout never changes Process state. */
  public async wait(processIdInput: string, timeoutMs = 0): Promise<ProcessWaitObservation> {
    const processId = requireId(processIdInput, 'processId');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new TypeError('wait timeoutMs must be a non-negative integer.');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const observed = await this.observeProcess(processId);
      if (observed.state !== 'running' || Date.now() >= deadline) return observed;
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }

  public async reconcileProcessExit(processIdInput: string): Promise<ProcessWaitObservation> {
    const processId = requireId(processIdInput, 'processId');
    const observed = await this.observeProcess(processId);
    if (observed.state === 'running') return observed;
    const existing = (await this.list('ProcessReceipt', { process_id: processId }, 2))[0];
    if (existing) return observed;
    const ids = processExitIds(processId);
    const intent = await this.requireExisting('EffectIntent', ids.effectIntentId);
    if (intent.effect_kind !== 'process_exit') throw new Error('Process exit observation has no process_exit EffectIntent.');
    const recorded = await this.effects.recordEffectReceipt({
      source: { kind: 'callback', key: `process-exit:${ids.attemptId}:receipt` },
      attemptId: ids.attemptId,
      effectKind: 'process_exit',
      outcome: processExitOutcome(observed),
      detail: observed
    });
    return this.reconcileExitEffectReceipt(recorded.effectReceiptId, 'internal');
  }

  public async reconcileExitEffectReceipt(
    effectReceiptIdInput: string,
    sourceKind: 'internal' | 'recovery'
  ): Promise<ProcessWaitObservation> {
    const effectReceiptId = requireId(effectReceiptIdInput, 'effectReceiptId');
    const receipt = await this.requireExisting('EffectReceipt', effectReceiptId);
    if (receipt.effect_kind !== 'process_exit') throw new Error('EffectReceipt is not process_exit.');
    const attempt = await this.requireExisting('Attempt', requireId(receipt.attempt_id, 'EffectReceipt.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    if (operation.owner_kind !== 'process' || operation.tool_call_id !== null) {
      throw new Error('process_exit Operation must be owned by Process and detached from ToolCall.');
    }
    const processId = requireId(operation.owner_id, 'Operation.owner_id');
    const processRow = await this.requireExisting('Process', processId);
    const intents = await this.list('EffectIntent', { attempt_id: attempt.id }, 2);
    if (intents.length !== 1) throw new Error('process_exit Attempt must have one EffectIntent.');
    const request = normalizeExitRequest(
      await this.effects.readEffectRequest<ProcessExitEffectRequest>(intents[0].id as string)
    );
    assertExitRequestMatchesProcess(request, processRow);
    const detail = await this.readReceiptDetail<unknown>(receipt);
    const observed = normalizeProcessExitObservation(detail, processRow, receipt.outcome);
    const now = this.timestamp();
    const additionalSteps: RepositoryTransactionStep[] = [];
    if (observed.state === 'outcome_unknown') {
      additionalSteps.push(
        DOMAIN_REPOSITORIES.domain('ProcessReceipt').insert({
          id: stablePhaseDId('process_receipt', processId),
          process_id: processId,
          outcome: 'outcome_unknown',
          exit_code: null,
          exit_signal: null,
          wrapper_nonce: processRow.wrapper_nonce,
          start_fingerprint: processRow.start_fingerprint,
          received_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Process').update(processId, {
          status: 'outcome_unknown',
          updated_at: now,
          completed_at: now
        })
      );
    } else {
      const exit = observed.receipt;
      const outcome = processExitOutcome(observed);
      additionalSteps.push(
        DOMAIN_REPOSITORIES.domain('ProcessReceipt').insert({
          id: stablePhaseDId('process_receipt', processId),
          process_id: processId,
          outcome,
          exit_code: exit.exitCode,
          exit_signal: exit.signal,
          wrapper_nonce: exit.stableNonce,
          start_fingerprint: exit.startFingerprint,
          received_at: now
        }),
        DOMAIN_REPOSITORIES.domain('Process').update(processId, {
          status: exit.stopRequested ? 'cancelled' : 'exited',
          retained_bytes: exit.retainedBytes,
          retained_chunks: exit.retainedChunks,
          dropped_bytes: exit.droppedBytes,
          truncated: exit.truncated ? '1' : '0',
          updated_at: now,
          completed_at: exit.exitedAt
        })
      );
    }
    await this.effects.completeDetachedOperation({
      source: { kind: sourceKind, key: `process-exit-reconcile:${effectReceiptId}` },
      effectReceiptId,
      outcome: processExitOutcome(observed),
      additionalSteps
    });
    return this.observeProcess(processId);
  }

  public async recoverDispatchedExit(input: {
    source: PhaseDCommandSource;
    effectIntentId: string;
  }): Promise<ProcessWaitObservation> {
    if (input.source.kind !== 'recovery') throw new TypeError('Process exit recovery requires recovery source kind.');
    const intent = await this.requireExisting('EffectIntent', requireId(input.effectIntentId, 'effectIntentId'));
    if (intent.effect_kind !== 'process_exit') throw new Error('Recovery target must be process_exit.');
    const attempt = await this.requireExisting('Attempt', requireId(intent.attempt_id, 'EffectIntent.attempt_id'));
    const operation = await this.requireExisting('Operation', requireId(attempt.operation_id, 'Attempt.operation_id'));
    const processId = requireId(operation.owner_id, 'Operation.owner_id');
    const processRow = await this.requireExisting('Process', processId);
    const request = normalizeExitRequest(
      await this.effects.readEffectRequest<ProcessExitEffectRequest>(intent.id as string)
    );
    assertExitRequestMatchesProcess(request, processRow);
    const existing = (await this.list('EffectReceipt', { attempt_id: attempt.id }, 2))[0];
    if (existing) return this.reconcileExitEffectReceipt(existing.id as string, 'recovery');
    if (intent.dispatch_state !== 'dispatched') {
      throw new Error('Recovery without a Receipt requires a dispatched process_exit EffectIntent.');
    }
    const observed = await this.observeProcess(processId);
    if (observed.state === 'running') return observed;
    const recorded = await this.effects.recordEffectReceipt({
      source: input.source,
      attemptId: attempt.id as string,
      effectKind: 'process_exit',
      outcome: processExitOutcome(observed),
      detail: observed
    });
    return this.reconcileExitEffectReceipt(recorded.effectReceiptId, 'recovery');
  }

  /** Recovery never launches again: it only verifies wrapper evidence or records unknown. */
  public async recoverDispatchedStart(input: {
    source: PhaseDCommandSource;
    effectIntentId: string;
  }): Promise<ToolTerminalResult | null> {
    if (input.source.kind !== 'recovery') throw new TypeError('Process recovery requires recovery source kind.');
    const intent = await this.requireExisting('EffectIntent', requireId(input.effectIntentId, 'effectIntentId'));
    if (intent.effect_kind !== PROCESS_START) throw new Error('Recovery target must be process_start.');
    const existing = (await this.list('EffectReceipt', { attempt_id: intent.attempt_id }, 2))[0];
    if (existing) return this.reconcileStartReceipt(existing.id as string);
    if (intent.dispatch_state !== 'dispatched') {
      throw new Error('Recovery without a Receipt requires a dispatched process_start EffectIntent.');
    }
    const request = normalizeStartRequest(await this.effects.readEffectRequest<ProcessStartRequest>(intent.id as string));
    await this.validateBinding();
    const spoolPath = processSpoolPath(this.binding, request.spoolLocator);
    let launch: ProcessLaunchObservation;
    try {
      const identity = parseWrapperIdentity(await readJson(path.join(spoolPath, PROCESS_WRAPPER_IDENTITY_FILE)));
      assertIdentityMatchesStart(identity, request);
      launch = { outcome: 'succeeded', identity };
    } catch (identityError) {
      try {
        const receipt = parseWrapperExitReceipt(await readJson(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE)));
        assertExitReceiptMatchesStartRequest(request, receipt);
        launch = {
          outcome: 'succeeded',
          identity: identityFromExitReceipt(request, receipt, requireText(intent.created_at, 'EffectIntent.created_at'))
        };
      } catch (receiptError) {
        launch = {
          outcome: 'outcome_unknown',
          error: `${errorMessage(identityError)}; ${errorMessage(receiptError)}`
        };
      }
    }
    const observation = await this.observeStart(request, launch, 0);
    const recorded = await this.effects.recordEffectReceipt({
      source: input.source,
      attemptId: intent.attempt_id as string,
      effectKind: PROCESS_START,
      outcome: observation.outcome,
      detail: observation
    });
    return this.reconcileStartReceipt(recorded.effectReceiptId);
  }

  private async observeProcess(processId: string): Promise<ProcessWaitObservation> {
    await this.validateBinding();
    const processRow = await this.requireExisting('Process', processId);
    const persisted = (await this.list('ProcessReceipt', { process_id: processId }, 2))[0];
    if (persisted) return persistedProcessObservation(processRow, persisted);
    const spoolPath = processSpoolPath(this.binding, requireText(processRow.spool_locator, 'Process.spool_locator'));
    try {
      const receipt = parseWrapperExitReceipt(await readJson(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE)));
      assertExitReceiptMatchesProcess(processRow, receipt);
      return { state: 'exited', processId, receipt };
    } catch (error) {
      if (!isNotFound(error)) return { state: 'outcome_unknown', processId, reason: errorMessage(error) };
    }
    let identity: ProcessWrapperIdentity;
    try {
      identity = await this.requireMatchingIdentity(processRow, spoolPath);
    } catch (error) {
      return { state: 'outcome_unknown', processId, reason: errorMessage(error) };
    }
    return this.observeVerifiedIdentity(identity, spoolPath);
  }

  private async observeStart(
    request: ProcessStartRequest,
    launch: ProcessLaunchObservation,
    foregroundWaitMs: number
  ): Promise<ProcessStartObservation> {
    if (launch.outcome !== 'succeeded') {
      return { outcome: launch.outcome, launch, foreground: null };
    }
    await this.validateBinding();
    const spoolPath = processSpoolPath(this.binding, request.spoolLocator);
    const deadline = Date.now() + foregroundWaitMs;
    let foreground: ProcessWaitObservation;
    do {
      foreground = await this.observeVerifiedIdentity(launch.identity, spoolPath);
      if (foreground.state !== 'running' || Date.now() >= deadline) break;
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    } while (true);
    return {
      outcome: processWaitOutcome(foreground),
      launch,
      foreground
    };
  }

  private async observeVerifiedIdentity(
    identity: ProcessWrapperIdentity,
    spoolPath: string
  ): Promise<ProcessWaitObservation> {
    const processId = identity.processId;
    try {
      const raw = await readJson(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE));
      const receipt = parseWrapperExitReceipt(raw);
      assertExitReceiptMatches(identity, receipt);
      return { state: 'exited', processId, receipt };
    } catch (error) {
      if (!isNotFound(error)) return { state: 'outcome_unknown', processId, reason: errorMessage(error) };
    }
    if (!isLinuxWrapperProcessReachable(identity.wrapperPid, path.join(spoolPath, 'launch.json'))) {
      return {
        state: 'outcome_unknown',
        processId,
        reason: 'Recorded wrapper is unreachable and no valid atomic exit receipt exists.'
      };
    }
    try {
      if (readLinuxStartFingerprint(identity.childPid) !== identity.startFingerprint) {
        return {
          state: 'outcome_unknown',
          processId,
          reason: 'Live child PID no longer matches its persisted start fingerprint.'
        };
      }
    } catch (error) {
      if (!isNotFound(error)) {
        return { state: 'outcome_unknown', processId, reason: errorMessage(error) };
      }
      // The wrapper is still reachable: the child may have closed while its receipt is being fsynced.
    }
    return { state: 'running', processId };
  }

  private async readProcessOutputSnapshot(processId: string): Promise<ProcessOutputSnapshot> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Process').get(processId),
      DOMAIN_REPOSITORIES.domain('ProcessOutputChunk').list({
        where: { process_id: processId },
        orderBy: { column: 'chunk_seq', direction: 'asc' },
        limit: PROCESS_OUTPUT_MAX_RETAINED_CHUNKS
      })
    ]);
    const processRow = snapshot.snapshot[0];
    const registered = snapshot.snapshot[1];
    if (!processRow || Array.isArray(processRow)) throw new Error(`Process ${processId} does not exist.`);
    if (!Array.isArray(registered)) throw new TypeError('ProcessOutputChunk snapshot did not return rows.');
    return { processRow, registered };
  }

  private async readVerifiedSpoolPrefix(
    processRow: DomainRow,
    spoolPath: string
  ): Promise<VerifiedSpoolPrefix> {
    await this.requireMatchingSpoolEvidence(processRow, spoolPath);
    // The wrapper publishes each immutable chunk before advancing the manifest. Reading the
    // manifest first therefore selects a stable prefix even while the child keeps writing.
    const manifest = await this.readManifest(spoolPath, processRow);
    const counters = outputCounters(manifest);
    const nextChunkSeq = BigInt(manifest.nextChunkSeq);
    if (nextChunkSeq !== counters.retainedChunks + 1n) {
      throw new Error('Process wrapper manifest has an invalid nextChunkSeq.');
    }
    const chunks = listProcessSpoolChunks(spoolPath)
      .filter((chunk) => BigInt(chunk.chunkSeq) < nextChunkSeq);
    assertChunkBounds(chunks);
    return { manifest, chunks };
  }

  private async readStableLiveTails(
    spoolPath: string,
    processRow: DomainRow,
    manifest: ProcessWrapperManifest
  ): Promise<{ stdout: Buffer; stderr: Buffer } | undefined> {
    const stdout = await readOptionalBytes(path.join(spoolPath, 'live-tail-stdout.bin')) ?? Buffer.alloc(0);
    const stderr = await readOptionalBytes(path.join(spoolPath, 'live-tail-stderr.bin')) ?? Buffer.alloc(0);
    if (stdout.length > PROCESS_OUTPUT_MAX_TERMINAL_TAIL_BYTES_PER_STREAM
      || stderr.length > PROCESS_OUTPUT_MAX_TERMINAL_TAIL_BYTES_PER_STREAM) {
      throw new Error('Process live tail exceeds the per-stream frozen bound.');
    }
    if (await fileExists(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE))) return undefined;
    const after = await this.readManifest(spoolPath, processRow);
    if (!sameManifestSnapshot(manifest, after)) return undefined;
    if (
      BigInt(stdout.length) !== BigInt(manifest.stdoutTailBytes)
      || BigInt(stderr.length) !== BigInt(manifest.stderrTailBytes)
    ) throw new Error('Process live tail does not match its stable wrapper manifest.');
    return { stdout, stderr };
  }

  private async currentReconciledOutput(processId: string): Promise<ReconciledOutput> {
    const { processRow } = await this.readProcessOutputSnapshot(processId);
    const counters = processRowOutputCounters(processRow);
    return { ...counters, insertedChunks: 0 };
  }

  private async requireMatchingSpoolEvidence(processRow: DomainRow, spoolPath: string): Promise<void> {
    try {
      const receipt = parseWrapperExitReceipt(await readJson(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE)));
      assertExitReceiptMatchesProcess(processRow, receipt);
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await this.requireMatchingIdentity(processRow, spoolPath);
  }

  private async requireMatchingIdentity(processRow: DomainRow, spoolPath: string): Promise<ProcessWrapperIdentity> {
    const identity = parseWrapperIdentity(await readJson(path.join(spoolPath, PROCESS_WRAPPER_IDENTITY_FILE)));
    if (
      identity.processId !== processRow.id
      || identity.stableNonce !== processRow.wrapper_nonce
      || BigInt(identity.wrapperPid) !== requireBigInt(processRow.wrapper_pid, 'Process.wrapper_pid')
      || BigInt(identity.childPid) !== requireBigInt(processRow.child_pid, 'Process.child_pid')
      || BigInt(identity.processGroupId) !== requireBigInt(processRow.process_group_id, 'Process.process_group_id')
      || identity.startFingerprint !== processRow.start_fingerprint
      || identity.commandDigest !== processRow.command_digest
      || identity.spoolLocator !== processRow.spool_locator
    ) throw new Error('Process wrapper identity does not match persisted Process evidence.');
    return identity;
  }

  private async readManifest(spoolPath: string, processRow: DomainRow): Promise<ProcessWrapperManifest> {
    const manifest = parseWrapperManifest(await readJson(path.join(spoolPath, PROCESS_WRAPPER_MANIFEST_FILE)));
    if (manifest.processId !== processRow.id || manifest.stableNonce !== processRow.wrapper_nonce) {
      throw new Error('Process wrapper manifest identity mismatch.');
    }
    return manifest;
  }

  private async readReceiptDetail<T>(receipt: DomainRow): Promise<T | undefined> {
    if (receipt.response_object_id === null) return undefined;
    const metadata = await this.requireExisting(
      'ContentObject',
      requireId(receipt.response_object_id, 'EffectReceipt.response_object_id')
    ) as Parameters<ContentAddressedStore['read']>[0];
    return JSON.parse((await this.contentStore.read(metadata)).toString('utf8')) as T;
  }

  private async validateBinding(): Promise<void> {
    await this.authority.validate(this.binding);
  }

  private async maybeGet(domain: string, id: string): Promise<DomainRow | null> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).get(id)]);
    const row = snapshot.snapshot[0];
    if (Array.isArray(row)) throw new TypeError(`${domain} get returned rows.`);
    return row;
  }

  private async requireExisting(domain: string, id: string): Promise<DomainRow> {
    const row = await this.maybeGet(domain, id);
    if (!row) throw new Error(`${domain} ${id} does not exist.`);
    return row;
  }

  private async list(domain: string, where: DomainRow, limit: number): Promise<DomainRow[]> {
    const snapshot = await this.database.snapshot([DOMAIN_REPOSITORIES.domain(domain).list({ where, limit })]);
    const rows = snapshot.snapshot[0];
    if (!Array.isArray(rows)) throw new TypeError(`${domain} list did not return rows.`);
    return rows;
  }

  private timestamp(): string {
    return requireText(this.now(), 'clock result');
  }
}

function processStartFactSteps(
  request: ProcessStartRequest,
  toolCallId: string,
  identity: ProcessWrapperIdentity,
  foreground: ProcessWaitObservation,
  now: string,
  exitRequestContent?: PreparedContentObject
): RepositoryTransactionStep[] {
  const terminal = foreground.state !== 'running';
  const exited = foreground.state === 'exited' ? foreground.receipt : undefined;
  const outcome = processWaitOutcome(foreground);
  const processStatus = foreground.state === 'running'
    ? 'running'
    : foreground.state === 'outcome_unknown'
      ? 'outcome_unknown'
      : exited?.stopRequested
        ? 'cancelled'
        : 'exited';
  const steps: RepositoryTransactionStep[] = [
    DOMAIN_REPOSITORIES.domain('Process').insert({
      id: request.processId,
      status: processStatus,
      wrapper_nonce: identity.stableNonce,
      wrapper_pid: identity.wrapperPid,
      child_pid: identity.childPid,
      process_group_id: identity.processGroupId,
      start_fingerprint: identity.startFingerprint,
      command_digest: identity.commandDigest,
      spool_locator: identity.spoolLocator,
      retained_bytes: exited?.retainedBytes ?? '0',
      retained_chunks: exited?.retainedChunks ?? '0',
      dropped_bytes: exited?.droppedBytes ?? '0',
      truncated: exited?.truncated ? '1' : '0',
      started_at: identity.startedAt,
      updated_at: now,
      completed_at: terminal ? (exited?.exitedAt ?? now) : null
    }),
    DOMAIN_REPOSITORIES.domain('ProcessOriginLink').insert({
      id: stablePhaseDId('process_origin_link', request.processId),
      process_id: request.processId,
      tool_call_id: toolCallId,
      created_at: now
    })
  ];
  if (!terminal) {
    if (!exitRequestContent) throw new Error('Running Process requires a persisted process_exit request.');
    const ids = processExitIds(request.processId);
    steps.push(
      ...preparedContentSteps([exitRequestContent], 'process_exit_request'),
      DOMAIN_REPOSITORIES.domain('Operation').insert({
        id: ids.operationId,
        owner_kind: 'process',
        owner_id: request.processId,
        operation_seq: '1',
        tool_call_id: null,
        status: 'executing',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('Attempt').insert({
        id: ids.attemptId,
        operation_id: ids.operationId,
        attempt_seq: '1',
        status: 'dispatched',
        created_at: now,
        updated_at: now,
        completed_at: null
      }),
      DOMAIN_REPOSITORIES.domain('EffectIntent').insert({
        id: ids.effectIntentId,
        attempt_id: ids.attemptId,
        effect_kind: 'process_exit',
        dispatch_state: 'dispatched',
        request_object_id: exitRequestContent.metadata.id,
        created_at: now,
        updated_at: now
      })
    );
  } else {
    steps.push(DOMAIN_REPOSITORIES.domain('ProcessReceipt').insert({
      id: stablePhaseDId('process_receipt', request.processId),
      process_id: request.processId,
      outcome,
      exit_code: exited?.exitCode ?? null,
      exit_signal: exited?.signal ?? null,
      wrapper_nonce: identity.stableNonce,
      start_fingerprint: identity.startFingerprint,
      received_at: now
    }));
  }
  return steps;
}

function processExitRequest(identity: ProcessWrapperIdentity): ProcessExitEffectRequest {
  return {
    processId: identity.processId,
    stableNonce: identity.stableNonce,
    wrapperPid: identity.wrapperPid,
    childPid: identity.childPid,
    startFingerprint: identity.startFingerprint,
    processGroupId: identity.processGroupId,
    commandDigest: identity.commandDigest,
    spoolLocator: identity.spoolLocator
  };
}

function processExitIds(processId: string): { operationId: string; attemptId: string; effectIntentId: string } {
  const operationId = stablePhaseDId('operation', `process-exit:${processId}`);
  const attemptId = stablePhaseDId('attempt', `${operationId}:1`);
  return {
    operationId,
    attemptId,
    effectIntentId: stablePhaseDId('effect_intent', attemptId)
  };
}

function normalizeProcessStartObservation(
  value: unknown,
  request: ProcessStartRequest
): ProcessStartObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid process_start Receipt detail.');
  }
  const record = value as Record<string, unknown>;
  const outcome = requireProcessStartOutcome(record.outcome);
  const launchValue = record.launch;
  if (!launchValue || typeof launchValue !== 'object' || Array.isArray(launchValue)) {
    throw new TypeError('process_start Receipt lacks launch observation.');
  }
  const launchRecord = launchValue as Record<string, unknown>;
  let launch: ProcessLaunchObservation;
  if (launchRecord.outcome === 'succeeded') {
    const identity = parseWrapperIdentity(launchRecord.identity);
    assertIdentityMatchesStart(identity, request);
    launch = { outcome: 'succeeded', identity };
  } else if (launchRecord.outcome === 'failed' || launchRecord.outcome === 'outcome_unknown') {
    launch = {
      outcome: launchRecord.outcome,
      error: requireText(launchRecord.error, 'process launch error')
    };
  } else {
    throw new TypeError('Invalid process launch outcome.');
  }
  let foreground: ProcessWaitObservation | null = null;
  if (record.foreground !== null) {
    const observed = record.foreground;
    if (!observed || typeof observed !== 'object' || Array.isArray(observed)) {
      throw new TypeError('Invalid process foreground observation.');
    }
    const foregroundRecord = observed as Record<string, unknown>;
    const processId = requireId(foregroundRecord.processId, 'foreground.processId');
    if (processId !== request.processId) throw new Error('Foreground observation belongs to another Process.');
    if (foregroundRecord.state === 'running') {
      foreground = { state: 'running', processId };
    } else if (foregroundRecord.state === 'outcome_unknown') {
      foreground = {
        state: 'outcome_unknown',
        processId,
        reason: requireText(foregroundRecord.reason, 'foreground.reason')
      };
    } else if (foregroundRecord.state === 'exited') {
      if (launch.outcome !== 'succeeded') throw new Error('Exited foreground observation requires a wrapper identity.');
      const receipt = parseWrapperExitReceipt(foregroundRecord.receipt);
      assertExitReceiptMatches(launch.identity, receipt);
      foreground = { state: 'exited', processId, receipt };
    } else {
      throw new TypeError('Invalid process foreground state.');
    }
  }
  if (launch.outcome === 'succeeded') {
    if (!foreground || processWaitOutcome(foreground) !== outcome) {
      throw new Error('process_start foreground outcome does not match its Receipt.');
    }
  } else if (foreground !== null || launch.outcome !== outcome) {
    throw new Error('Failed/unknown process launch has inconsistent foreground facts.');
  }
  return { outcome, launch, foreground };
}

function normalizeProcessExitObservation(
  value: unknown,
  processRow: DomainRow,
  persistedOutcome: unknown
): Exclude<ProcessWaitObservation, { state: 'running' }> {
  const processId = requireId(processRow.id, 'Process.id');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (persistedOutcome === 'outcome_unknown') {
      return { state: 'outcome_unknown', processId, reason: 'process_exit Receipt has no provable exit detail.' };
    }
    throw new TypeError('process_exit Receipt lacks observation detail.');
  }
  const record = value as Record<string, unknown>;
  if (record.processId !== processId) throw new Error('process_exit observation belongs to another Process.');
  if (record.state === 'outcome_unknown') {
    if (persistedOutcome !== 'outcome_unknown') throw new Error('process_exit outcome/detail mismatch.');
    return {
      state: 'outcome_unknown',
      processId,
      reason: requireText(record.reason, 'process_exit unknown reason')
    };
  }
  if (record.state !== 'exited') throw new TypeError('process_exit observation must be exited or outcome_unknown.');
  const receipt = parseWrapperExitReceipt(record.receipt);
  assertExitReceiptMatchesProcess(processRow, receipt);
  const observed: ProcessWaitObservation = { state: 'exited', processId, receipt };
  if (processExitOutcome(observed) !== persistedOutcome) throw new Error('process_exit outcome/detail mismatch.');
  return observed;
}

function processExitOutcome(
  observed: ProcessWaitObservation
): 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' {
  if (observed.state === 'outcome_unknown') return 'outcome_unknown';
  if (observed.state === 'running') throw new Error('A running Process has no terminal process_exit outcome.');
  if (observed.receipt.stopRequested) return 'cancelled';
  return observed.receipt.exitCode === '0' ? 'succeeded' : 'failed';
}

function persistedProcessObservation(processRow: DomainRow, receipt: DomainRow): ProcessWaitObservation {
  const processId = requireId(processRow.id, 'Process.id');
  if (
    receipt.wrapper_nonce !== processRow.wrapper_nonce
    || receipt.start_fingerprint !== processRow.start_fingerprint
  ) return { state: 'outcome_unknown', processId, reason: 'Persisted ProcessReceipt identity mismatch.' };
  if (receipt.outcome === 'outcome_unknown') {
    return { state: 'outcome_unknown', processId, reason: 'Persisted ProcessReceipt records outcome_unknown.' };
  }
  if (!['succeeded', 'failed', 'cancelled'].includes(String(receipt.outcome))) {
    return { state: 'outcome_unknown', processId, reason: 'Persisted ProcessReceipt has an invalid outcome.' };
  }
  try {
    return {
      state: 'exited',
      processId,
      receipt: parseWrapperExitReceipt({
        kind: PROCESS_WRAPPER_PROTOCOL,
        processId,
        stableNonce: requireText(processRow.wrapper_nonce, 'Process.wrapper_nonce'),
        wrapperPid: requireBigInt(processRow.wrapper_pid, 'Process.wrapper_pid').toString(),
        childPid: requireBigInt(processRow.child_pid, 'Process.child_pid').toString(),
        processGroupId: requireBigInt(processRow.process_group_id, 'Process.process_group_id').toString(),
        startFingerprint: requireText(processRow.start_fingerprint, 'Process.start_fingerprint'),
        commandDigest: requireSha256(processRow.command_digest, 'Process.command_digest'),
        exitCode: receipt.exit_code === null ? null : requireBigInt(receipt.exit_code, 'ProcessReceipt.exit_code').toString(),
        signal: receipt.exit_signal === null ? null : requireText(receipt.exit_signal, 'ProcessReceipt.exit_signal'),
        exitedAt: requireText(processRow.completed_at ?? receipt.received_at, 'Process.completed_at'),
        retainedBytes: requireBigInt(processRow.retained_bytes, 'Process.retained_bytes').toString(),
        retainedChunks: requireBigInt(processRow.retained_chunks, 'Process.retained_chunks').toString(),
        droppedBytes: requireBigInt(processRow.dropped_bytes, 'Process.dropped_bytes').toString(),
        truncated: requireBigInt(processRow.truncated, 'Process.truncated') === 1n,
        stopRequested: receipt.outcome === 'cancelled'
      })
    };
  } catch {
    return { state: 'outcome_unknown', processId, reason: 'Persisted ProcessReceipt has an invalid exit tuple.' };
  }
}

function processWaitOutcome(
  observation: ProcessWaitObservation
): 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' {
  if (observation.state === 'running') return 'succeeded';
  if (observation.state === 'outcome_unknown') return 'outcome_unknown';
  if (observation.receipt.stopRequested) return 'cancelled';
  return observation.receipt.exitCode === '0' ? 'succeeded' : 'failed';
}

function requireProcessStopOutcome(value: unknown): 'succeeded' | 'outcome_unknown' {
  if (value !== 'succeeded' && value !== 'outcome_unknown') {
    throw new TypeError(`Invalid process_stop_request outcome: ${String(value)}.`);
  }
  return value;
}

function requireStreamKind(value: unknown): 'stdout' | 'stderr' {
  if (value !== 'stdout' && value !== 'stderr') {
    throw new TypeError(`Invalid ProcessOutputChunk.stream_kind: ${String(value)}.`);
  }
  return value;
}

function requireProcessStartOutcome(
  value: unknown
): 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown' {
  if (!['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(String(value))) {
    throw new TypeError(`Invalid process_start outcome: ${String(value)}.`);
  }
  return value as 'succeeded' | 'failed' | 'cancelled' | 'outcome_unknown';
}

function requireWaitDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('foregroundWaitMs must be a non-negative safe integer.');
  }
}

function assertExitReceiptMatchesStartRequest(request: ProcessStartRequest, receipt: ProcessWrapperExitReceipt): void {
  if (
    receipt.processId !== request.processId
    || receipt.stableNonce !== request.stableNonce
    || receipt.commandDigest !== request.commandDigest
  ) throw new Error('Process exit receipt does not match process_start request.');
}

function identityFromExitReceipt(
  request: ProcessStartRequest,
  receipt: ProcessWrapperExitReceipt,
  startedAt: string
): ProcessWrapperIdentity {
  return {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: request.processId,
    stableNonce: request.stableNonce,
    wrapperPid: receipt.wrapperPid,
    childPid: receipt.childPid,
    processGroupId: receipt.processGroupId,
    startFingerprint: receipt.startFingerprint,
    commandDigest: request.commandDigest,
    spoolLocator: request.spoolLocator,
    startedAt
  };
}

function assertExitReceiptMatchesProcess(processRow: DomainRow, receipt: ProcessWrapperExitReceipt): void {
  if (
    receipt.processId !== processRow.id
    || receipt.stableNonce !== processRow.wrapper_nonce
    || BigInt(receipt.wrapperPid) !== requireBigInt(processRow.wrapper_pid, 'Process.wrapper_pid')
    || BigInt(receipt.childPid) !== requireBigInt(processRow.child_pid, 'Process.child_pid')
    || BigInt(receipt.processGroupId) !== requireBigInt(processRow.process_group_id, 'Process.process_group_id')
    || receipt.startFingerprint !== processRow.start_fingerprint
    || receipt.commandDigest !== processRow.command_digest
  ) throw new Error('Process exit receipt does not match persisted Process evidence.');
}

function assertProcessMatchesIdentity(processRow: DomainRow, identity: ProcessWrapperIdentity): void {
  if (
    processRow.id !== identity.processId
    || processRow.wrapper_nonce !== identity.stableNonce
    || requireBigInt(processRow.wrapper_pid, 'Process.wrapper_pid').toString() !== identity.wrapperPid
    || requireBigInt(processRow.child_pid, 'Process.child_pid').toString() !== identity.childPid
    || requireBigInt(processRow.process_group_id, 'Process.process_group_id').toString() !== identity.processGroupId
    || processRow.start_fingerprint !== identity.startFingerprint
    || processRow.command_digest !== identity.commandDigest
    || processRow.spool_locator !== identity.spoolLocator
  ) throw new Error('Persisted Process does not match process_start wrapper identity.');
}

function normalizeStartRequest(value: ProcessStartRequest): ProcessStartRequest {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid process_start request.');
  const command = requireText(value.command, 'command');
  const cwd = path.resolve(requireText(value.cwd, 'cwd'));
  const digest = requireSha256(value.commandDigest, 'commandDigest');
  if (digest !== commandDigest(command, cwd)) throw new Error('process_start commandDigest mismatch.');
  return {
    processId: requireId(value.processId, 'processId'),
    stableNonce: requireNonce(value.stableNonce),
    command,
    cwd,
    commandDigest: digest,
    spoolLocator: requireLocator(value.spoolLocator)
  };
}

function normalizeExitRequest(value: ProcessExitEffectRequest): ProcessExitEffectRequest {
  const stop = normalizeStopRequest(value);
  return {
    ...stop,
    wrapperPid: requireDecimalString(value.wrapperPid, 'wrapperPid'),
    childPid: requireDecimalString(value.childPid, 'childPid')
  };
}

function assertExitRequestMatchesProcess(request: ProcessExitEffectRequest, processRow: DomainRow): void {
  if (
    !processEvidenceMatches(processRow, request)
    || BigInt(request.wrapperPid) !== requireBigInt(processRow.wrapper_pid, 'Process.wrapper_pid')
    || BigInt(request.childPid) !== requireBigInt(processRow.child_pid, 'Process.child_pid')
  ) throw new Error('process_exit request does not match persisted Process evidence.');
}

function normalizeStopRequest(value: ProcessStopEffectRequest): ProcessStopEffectRequest {
  if (!value || typeof value !== 'object') throw new TypeError('Invalid process_stop_request.');
  return {
    processId: requireId(value.processId, 'processId'),
    stableNonce: requireNonce(value.stableNonce),
    startFingerprint: requireText(value.startFingerprint, 'startFingerprint'),
    processGroupId: requireDecimalString(value.processGroupId, 'processGroupId'),
    commandDigest: requireSha256(value.commandDigest, 'commandDigest'),
    spoolLocator: requireLocator(value.spoolLocator)
  };
}

function processEvidenceMatches(processRow: DomainRow, request: ProcessStopEffectRequest): boolean {
  return processRow.id === request.processId
    && processRow.wrapper_nonce === request.stableNonce
    && processRow.start_fingerprint === request.startFingerprint
    && requireBigInt(processRow.process_group_id, 'Process.process_group_id').toString() === request.processGroupId
    && processRow.command_digest === request.commandDigest
    && processRow.spool_locator === request.spoolLocator;
}

function assertIdentityMatchesStart(identity: ProcessWrapperIdentity, request: ProcessStartRequest): void {
  if (
    identity.processId !== request.processId
    || identity.stableNonce !== request.stableNonce
    || identity.commandDigest !== request.commandDigest
    || identity.spoolLocator !== request.spoolLocator
  ) throw new Error('Wrapper identity does not match process_start request.');
}

function assertStopRequestMatchesEffect(request: ProcessStopEffectRequest, persisted: ProcessStopRequest): void {
  if (
    persisted.processId !== request.processId
    || persisted.stableNonce !== request.stableNonce
    || persisted.startFingerprint !== request.startFingerprint
    || persisted.processGroupId !== request.processGroupId
    || persisted.commandDigest !== request.commandDigest
  ) throw new Error('Atomic stop request does not match process_stop_request evidence.');
}

function assertIdentityMatchesStop(identity: ProcessWrapperIdentity, request: ProcessStopEffectRequest): void {
  if (
    identity.processId !== request.processId
    || identity.stableNonce !== request.stableNonce
    || identity.startFingerprint !== request.startFingerprint
    || identity.processGroupId !== request.processGroupId
    || identity.commandDigest !== request.commandDigest
    || identity.spoolLocator !== request.spoolLocator
  ) throw new Error('Wrapper identity does not match process_stop_request evidence.');
}

function assertExitReceiptMatches(identity: ProcessWrapperIdentity, receipt: ProcessWrapperExitReceipt): void {
  if (
    receipt.processId !== identity.processId
    || receipt.stableNonce !== identity.stableNonce
    || receipt.wrapperPid !== identity.wrapperPid
    || receipt.childPid !== identity.childPid
    || receipt.processGroupId !== identity.processGroupId
    || receipt.startFingerprint !== identity.startFingerprint
    || receipt.commandDigest !== identity.commandDigest
  ) throw new Error('Atomic wrapper exit receipt identity mismatch.');
  if (
    BigInt(receipt.retainedBytes) > BigInt(PROCESS_OUTPUT_MAX_RETAINED_BYTES)
    || BigInt(receipt.retainedChunks) > BigInt(PROCESS_OUTPUT_MAX_RETAINED_CHUNKS)
  ) throw new Error('Atomic wrapper exit receipt exceeds frozen output limits.');
}

function outputCounters(manifest: ProcessWrapperManifest): ProcessOutputCounters {
  const counters = {
    retainedBytes: BigInt(manifest.retainedBytes),
    retainedChunks: BigInt(manifest.retainedChunks),
    droppedBytes: BigInt(manifest.droppedBytes),
    truncated: manifest.truncated
  };
  assertOutputBounds(counters.retainedBytes, counters.retainedChunks);
  return counters;
}

function processRowOutputCounters(processRow: DomainRow): ProcessOutputCounters {
  const counters = {
    retainedBytes: requireBigInt(processRow.retained_bytes, 'Process.retained_bytes'),
    retainedChunks: requireBigInt(processRow.retained_chunks, 'Process.retained_chunks'),
    droppedBytes: requireBigInt(processRow.dropped_bytes, 'Process.dropped_bytes'),
    truncated: requireBigInt(processRow.truncated, 'Process.truncated') === 1n
  };
  assertOutputBounds(counters.retainedBytes, counters.retainedChunks);
  return counters;
}

function assertProcessOutputProgress(
  processRow: DomainRow,
  observed: ProcessOutputCounters,
  manifestStatus: ProcessWrapperManifest['status']
): void {
  const persisted = processRowOutputCounters(processRow);
  if (processRow.status !== 'running') {
    if (manifestStatus !== 'exited' || !outputCounterValuesEqual(persisted, observed)) {
      throw new Error('Terminal Process counters do not match the final wrapper manifest.');
    }
    return;
  }
  if (
    observed.retainedBytes < persisted.retainedBytes
    || observed.retainedChunks < persisted.retainedChunks
    || observed.droppedBytes < persisted.droppedBytes
    || (persisted.truncated && !observed.truncated)
  ) throw new Error('Process wrapper counters moved backwards.');
}

function processCountersEqual(processRow: DomainRow, observed: ProcessOutputCounters): boolean {
  return outputCounterValuesEqual(processRowOutputCounters(processRow), observed);
}

function outputCounterValuesEqual(left: ProcessOutputCounters, right: ProcessOutputCounters): boolean {
  return left.retainedBytes === right.retainedBytes
    && left.retainedChunks === right.retainedChunks
    && left.droppedBytes === right.droppedBytes
    && left.truncated === right.truncated;
}

function assertOutputCoverage(
  representedBytes: bigint,
  representedChunks: bigint,
  retainedBytes: bigint,
  retainedChunks: bigint
): void {
  if (representedBytes !== retainedBytes || representedChunks !== retainedChunks) {
    throw new Error('Registered CAS chunks plus verified spool do not cover retained process output.');
  }
}

function assertOutputBounds(retainedBytes: bigint, retainedChunks: bigint): void {
  if (
    retainedBytes < 0n
    || retainedChunks < 0n
    || retainedBytes > BigInt(PROCESS_OUTPUT_MAX_RETAINED_BYTES)
    || retainedChunks > BigInt(PROCESS_OUTPUT_MAX_RETAINED_CHUNKS)
  ) throw new Error('Process output exceeds frozen retention bounds.');
}

function sameManifestSnapshot(left: ProcessWrapperManifest, right: ProcessWrapperManifest): boolean {
  return left.kind === right.kind
    && left.processId === right.processId
    && left.stableNonce === right.stableNonce
    && left.status === right.status
    && left.nextChunkSeq === right.nextChunkSeq
    && left.retainedBytes === right.retainedBytes
    && left.retainedChunks === right.retainedChunks
    && left.droppedBytes === right.droppedBytes
    && left.truncated === right.truncated
    && left.stdoutTailBytes === right.stdoutTailBytes
    && left.stderrTailBytes === right.stderrTailBytes
    && left.updatedAt === right.updatedAt;
}

function isTransactionAssertionFailure(error: unknown): boolean {
  return (error as Error & { code?: string }).code === 'RUNTIME_TRANSACTION_ASSERTION_FAILED';
}

function assertChunkBounds(chunks: ReturnType<typeof listProcessSpoolChunks>): void {
  if (chunks.length > PROCESS_OUTPUT_MAX_RETAINED_CHUNKS) throw new Error('Process spool has too many chunks.');
  let total = 0n;
  const seen = new Set<string>();
  for (const chunk of chunks) {
    if (seen.has(chunk.chunkSeq)) throw new Error(`Duplicate process chunk sequence ${chunk.chunkSeq}.`);
    seen.add(chunk.chunkSeq);
    const length = BigInt(chunk.byteLength);
    if (length <= 0n || length > BigInt(PROCESS_OUTPUT_MAX_CHUNK_BYTES)) throw new Error('Invalid process chunk length.');
    total += length;
  }
  if (total > BigInt(PROCESS_OUTPUT_MAX_RETAINED_BYTES)) throw new Error('Process spool exceeds retained bytes limit.');
}

async function waitForLaunchEvidence(
  request: ProcessStartRequest,
  spoolPath: string,
  startedAt: string,
  timeoutMs: number
): Promise<ProcessLaunchObservation> {
  const deadline = Date.now() + timeoutMs;
  const identityPath = path.join(spoolPath, PROCESS_WRAPPER_IDENTITY_FILE);
  const exitPath = path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE);
  let lastError = 'Wrapper launch evidence did not appear.';
  while (Date.now() <= deadline) {
    try {
      const identity = parseWrapperIdentity(await readJson(identityPath));
      assertIdentityMatchesStart(identity, request);
      return { outcome: 'succeeded', identity };
    } catch (error) {
      if (!isNotFound(error)) lastError = errorMessage(error);
    }
    try {
      const receipt = parseWrapperExitReceipt(await readJson(exitPath));
      assertExitReceiptMatchesStartRequest(request, receipt);
      return {
        outcome: 'succeeded',
        identity: identityFromExitReceipt(request, receipt, startedAt)
      };
    } catch (error) {
      if (!isNotFound(error)) lastError = errorMessage(error);
    }
    await sleep(WRAPPER_IDENTITY_POLL_MS);
  }
  return { outcome: 'outcome_unknown', error: lastError };
}

async function writeAtomicJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporary, filePath);
  const directory = await fs.open(path.dirname(filePath), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readOptionalBytes(filePath: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

function commandDigest(command: string, cwd: string): string {
  return createHash('sha256')
    .update('limcode-process-command\0')
    .update(command)
    .update('\0')
    .update(cwd)
    .digest('hex');
}

function requireNonce(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{32}$/.test(value)) throw new TypeError('stableNonce must be 128-bit lowercase hex.');
  return value;
}

function requireLocator(value: unknown): string {
  const locator = requireText(value, 'spoolLocator');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(locator)) throw new TypeError('Invalid spoolLocator.');
  return locator;
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} must be lowercase SHA-256.`);
  return value;
}

function requireBigInt(value: unknown, label: string): bigint {
  if (typeof value !== 'bigint') throw new TypeError(`${label} must remain bigint in JavaScript.`);
  return value;
}

function requireDecimalString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) throw new TypeError(`${label} must be a decimal integer string.`);
  return value;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
