import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  PROCESS_OUTPUT_MAX_CHUNK_BYTES,
  PROCESS_OUTPUT_MAX_FLUSH_DELAY_MS,
  PROCESS_OUTPUT_MAX_RETAINED_BYTES,
  PROCESS_OUTPUT_MAX_RETAINED_CHUNKS,
  PROCESS_OUTPUT_MAX_TERMINAL_TAIL_BYTES_PER_STREAM,
  PROCESS_WRAPPER_CHUNKS_DIRECTORY,
  PROCESS_WRAPPER_EXIT_RECEIPT_FILE,
  PROCESS_WRAPPER_IDENTITY_FILE,
  PROCESS_WRAPPER_MANIFEST_FILE,
  PROCESS_WRAPPER_PROTOCOL,
  PROCESS_WRAPPER_STOP_REQUEST_FILE,
  parseStopRequest,
  processChunkFileName,
  readLinuxStartFingerprint,
  type ProcessStopRequest,
  type ProcessStreamKind,
  type ProcessWrapperExitReceipt,
  type ProcessWrapperIdentity,
  type ProcessWrapperLaunchRequest,
  type ProcessWrapperManifest
} from './processProtocol';

interface StreamState {
  tail: Buffer;
}

interface WrapperState {
  request: ProcessWrapperLaunchRequest;
  identity: ProcessWrapperIdentity;
  spoolPath: string;
  chunksPath: string;
  nextChunkSeq: bigint;
  retainedBytes: bigint;
  retainedChunks: bigint;
  droppedBytes: bigint;
  truncated: boolean;
  stopRequested: boolean;
  flushTimer: NodeJS.Timeout | null;
  flushError: Error | null;
  stdout: StreamState;
  stderr: StreamState;
}

const REGULAR_BYTES_BUDGET = BigInt(
  PROCESS_OUTPUT_MAX_RETAINED_BYTES - (2 * PROCESS_OUTPUT_MAX_TERMINAL_TAIL_BYTES_PER_STREAM)
);
const REGULAR_CHUNKS_BUDGET = BigInt(PROCESS_OUTPUT_MAX_RETAINED_CHUNKS - 2);

if (require.main === module) {
  runWrapper(process.argv[2]).catch((error) => {
    // Missing/corrupt evidence is deliberately handled as outcome_unknown by the host recovery scan.
    console.error(`[limcode-process-wrapper] ${boundedErrorMessage(error)}`);
    process.exitCode = 1;
  });
}

async function runWrapper(requestPathInput: string | undefined): Promise<void> {
  if (!requestPathInput) throw new Error('Process wrapper requires a launch request path.');
  const requestPath = path.resolve(requestPathInput);
  const spoolPath = path.dirname(requestPath);
  const request = parseLaunchRequest(JSON.parse(fs.readFileSync(requestPath, 'utf8')));
  if (path.basename(spoolPath) !== request.spoolLocator) throw new Error('Launch request spool locator mismatch.');
  const chunksPath = path.join(spoolPath, PROCESS_WRAPPER_CHUNKS_DIRECTORY);
  fs.mkdirSync(chunksPath, { recursive: true });

  const bootstrapCommand = `IFS= read -r _ <&3 || exit 125; exec /bin/sh -c ${shellQuote(request.command)}`;
  const child = spawn(bootstrapCommand, {
    cwd: request.cwd,
    shell: '/bin/sh',
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  if (!child.pid) {
    await exitPromise;
    throw new Error('Detached wrapper did not observe a child PID.');
  }
  const childPid = String(child.pid);
  let startFingerprint: string;
  try {
    startFingerprint = readLinuxStartFingerprint(childPid);
  } catch (error) {
    await abortBlockedChild(childPid, exitPromise);
    throw error;
  }
  const identity: ProcessWrapperIdentity = {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: request.processId,
    stableNonce: request.stableNonce,
    wrapperPid: String(process.pid),
    childPid,
    processGroupId: childPid,
    startFingerprint,
    commandDigest: request.commandDigest,
    spoolLocator: request.spoolLocator,
    startedAt: new Date().toISOString()
  };
  const state: WrapperState = {
    request,
    identity,
    spoolPath,
    chunksPath,
    nextChunkSeq: 1n,
    retainedBytes: 0n,
    retainedChunks: 0n,
    droppedBytes: 0n,
    truncated: false,
    stopRequested: false,
    flushTimer: null,
    flushError: null,
    stdout: { tail: Buffer.alloc(0) },
    stderr: { tail: Buffer.alloc(0) }
  };
  try {
    writeAtomicJson(path.join(spoolPath, PROCESS_WRAPPER_IDENTITY_FILE), identity);
    writeManifest(state, 'running');
  } catch (error) {
    await abortBlockedChild(childPid, exitPromise);
    throw error;
  }

  child.stdout?.on('data', (chunk: Buffer | string) => retainOutput(state, 'stdout', Buffer.from(chunk)));
  child.stderr?.on('data', (chunk: Buffer | string) => retainOutput(state, 'stderr', Buffer.from(chunk)));
  const stopPoll = setInterval(() => observeStopRequest(state), Math.min(100, PROCESS_OUTPUT_MAX_FLUSH_DELAY_MS));
  const bootstrapGate = child.stdio[3];
  if (!bootstrapGate || typeof (bootstrapGate as NodeJS.WritableStream).end !== 'function') {
    clearInterval(stopPoll);
    await abortBlockedChild(childPid, exitPromise);
    throw new Error('Detached wrapper bootstrap pipe is unavailable.');
  }
  (bootstrapGate as NodeJS.WritableStream).end('\n');

  const exit = await exitPromise.finally(() => clearInterval(stopPoll));

  cancelScheduledFlush(state);
  if (state.flushError) throw state.flushError;
  retainTerminalTail(state, 'stdout');
  retainTerminalTail(state, 'stderr');
  removeIfExists(path.join(spoolPath, 'live-tail-stdout.bin'));
  removeIfExists(path.join(spoolPath, 'live-tail-stderr.bin'));
  writeManifest(state, 'exited');
  const receipt: ProcessWrapperExitReceipt = {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: identity.processId,
    stableNonce: identity.stableNonce,
    wrapperPid: identity.wrapperPid,
    childPid: identity.childPid,
    processGroupId: identity.processGroupId,
    startFingerprint: identity.startFingerprint,
    commandDigest: identity.commandDigest,
    exitCode: exit.code === null ? null : String(exit.code),
    signal: exit.signal,
    exitedAt: new Date().toISOString(),
    retainedBytes: state.retainedBytes.toString(),
    retainedChunks: state.retainedChunks.toString(),
    droppedBytes: state.droppedBytes.toString(),
    truncated: state.truncated,
    stopRequested: state.stopRequested
  };
  // The atomic exit receipt is the only cross-host terminal authority.
  writeAtomicJson(path.join(spoolPath, PROCESS_WRAPPER_EXIT_RECEIPT_FILE), receipt);
}

function retainOutput(state: WrapperState, streamKind: ProcessStreamKind, bytes: Buffer): void {
  if (bytes.length === 0) return;
  const stream = state[streamKind];
  const combined = Buffer.concat([stream.tail, bytes]);
  const tailBudget = PROCESS_OUTPUT_MAX_TERMINAL_TAIL_BYTES_PER_STREAM;
  const flushBytes = Math.max(0, combined.length - tailBudget);
  if (flushBytes > 0) retainRegularBytes(state, streamKind, combined.subarray(0, flushBytes));
  stream.tail = Buffer.from(combined.subarray(flushBytes));
  scheduleRunningFlush(state);
}

function retainRegularBytes(state: WrapperState, streamKind: ProcessStreamKind, bytes: Buffer): void {
  let offset = 0;
  while (offset < bytes.length) {
    const bytesRemaining = REGULAR_BYTES_BUDGET - state.retainedBytes;
    const chunksRemaining = REGULAR_CHUNKS_BUDGET - state.retainedChunks;
    if (bytesRemaining <= 0n || chunksRemaining <= 0n) {
      const dropped = BigInt(bytes.length - offset);
      state.droppedBytes += dropped;
      state.truncated = state.truncated || dropped > 0n;
      return;
    }
    const length = Math.min(
      PROCESS_OUTPUT_MAX_CHUNK_BYTES,
      bytes.length - offset,
      Number(bytesRemaining > BigInt(PROCESS_OUTPUT_MAX_CHUNK_BYTES)
        ? BigInt(PROCESS_OUTPUT_MAX_CHUNK_BYTES)
        : bytesRemaining)
    );
    writeChunk(state, streamKind, bytes.subarray(offset, offset + length));
    offset += length;
  }
}

function retainTerminalTail(state: WrapperState, streamKind: ProcessStreamKind): void {
  const stream = state[streamKind];
  const tail = stream.tail;
  if (tail.length === 0) return;
  const totalBytesLimit = BigInt(PROCESS_OUTPUT_MAX_RETAINED_BYTES);
  const totalChunksLimit = BigInt(PROCESS_OUTPUT_MAX_RETAINED_CHUNKS);
  const availableBytes = totalBytesLimit - state.retainedBytes;
  if (availableBytes <= 0n || state.retainedChunks >= totalChunksLimit) {
    state.droppedBytes += BigInt(tail.length);
    state.truncated = true;
    stream.tail = Buffer.alloc(0);
    return;
  }
  const length = Math.min(tail.length, Number(availableBytes));
  writeChunk(state, streamKind, tail.subarray(tail.length - length));
  if (length < tail.length) {
    state.droppedBytes += BigInt(tail.length - length);
    state.truncated = true;
  }
  stream.tail = Buffer.alloc(0);
}

function writeChunk(state: WrapperState, streamKind: ProcessStreamKind, bytes: Buffer): void {
  if (bytes.length <= 0 || bytes.length > PROCESS_OUTPUT_MAX_CHUNK_BYTES) {
    throw new Error('Process wrapper chunk exceeds frozen maxChunkBytes.');
  }
  const fileName = processChunkFileName(state.nextChunkSeq, streamKind);
  writeAtomicBytes(path.join(state.chunksPath, fileName), bytes);
  state.nextChunkSeq += 1n;
  state.retainedBytes += BigInt(bytes.length);
  state.retainedChunks += 1n;
  if (
    state.retainedBytes > BigInt(PROCESS_OUTPUT_MAX_RETAINED_BYTES)
    || state.retainedChunks > BigInt(PROCESS_OUTPUT_MAX_RETAINED_CHUNKS)
  ) throw new Error('Process wrapper exceeded frozen retention bounds.');
}

function observeStopRequest(state: WrapperState): void {
  if (state.stopRequested) return;
  const requestPath = path.join(state.spoolPath, PROCESS_WRAPPER_STOP_REQUEST_FILE);
  let parsed: ProcessStopRequest;
  try {
    parsed = parseStopRequest(JSON.parse(fs.readFileSync(requestPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    console.warn(`[limcode-process-wrapper] ignored invalid stop request: ${boundedErrorMessage(error)}`);
    return;
  }
  const identity = state.identity;
  if (
    parsed.processId !== identity.processId
    || parsed.stableNonce !== identity.stableNonce
    || parsed.startFingerprint !== identity.startFingerprint
    || parsed.processGroupId !== identity.processGroupId
    || parsed.commandDigest !== identity.commandDigest
  ) return;
  // Re-check the live child start fingerprint immediately before signaling its process group.
  // If the child just exited, leave the wrapper alive so its close path can publish the exit receipt.
  try {
    if (readLinuxStartFingerprint(identity.childPid) !== identity.startFingerprint) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  state.stopRequested = true;
  try {
    process.kill(-Number(identity.processGroupId), 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function scheduleRunningFlush(state: WrapperState): void {
  if (state.flushTimer || state.flushError) return;
  state.flushTimer = setTimeout(() => {
    state.flushTimer = null;
    try {
      flushRunningState(state);
    } catch (error) {
      state.flushError = error instanceof Error ? error : new Error(String(error));
    }
  }, PROCESS_OUTPUT_MAX_FLUSH_DELAY_MS);
  state.flushTimer.unref();
}

function cancelScheduledFlush(state: WrapperState): void {
  if (!state.flushTimer) return;
  clearTimeout(state.flushTimer);
  state.flushTimer = null;
}

function flushRunningState(state: WrapperState): void {
  writeAtomicBytes(path.join(state.spoolPath, 'live-tail-stdout.bin'), state.stdout.tail);
  writeAtomicBytes(path.join(state.spoolPath, 'live-tail-stderr.bin'), state.stderr.tail);
  writeManifest(state, 'running');
}

function writeManifest(state: WrapperState, status: ProcessWrapperManifest['status']): void {
  const manifest: ProcessWrapperManifest = {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: state.identity.processId,
    stableNonce: state.identity.stableNonce,
    status,
    nextChunkSeq: state.nextChunkSeq.toString(),
    retainedBytes: state.retainedBytes.toString(),
    retainedChunks: state.retainedChunks.toString(),
    droppedBytes: state.droppedBytes.toString(),
    truncated: state.truncated,
    stdoutTailBytes: String(state.stdout.tail.length),
    stderrTailBytes: String(state.stderr.tail.length),
    updatedAt: new Date().toISOString()
  };
  writeAtomicJson(path.join(state.spoolPath, PROCESS_WRAPPER_MANIFEST_FILE), manifest);
}

function parseLaunchRequest(value: unknown): ProcessWrapperLaunchRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid process launch request.');
  const record = value as Record<string, unknown>;
  const keys = [
    'kind', 'processId', 'stableNonce', 'command', 'cwd', 'commandDigest', 'spoolLocator', 'createdAt'
  ].sort();
  const actual = Object.keys(record).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new TypeError('Process launch request fields do not match wrapper contract.');
  }
  if (record.kind !== PROCESS_WRAPPER_PROTOCOL) throw new TypeError('Invalid process launch request kind.');
  const text = (field: string): string => {
    const current = record[field];
    if (typeof current !== 'string' || current.length === 0) throw new TypeError(`Invalid launch request ${field}.`);
    return current;
  };
  const digest = text('commandDigest');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('Invalid launch request commandDigest.');
  const locator = text('spoolLocator');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(locator)) throw new TypeError('Invalid launch request spoolLocator.');
  return {
    kind: PROCESS_WRAPPER_PROTOCOL,
    processId: text('processId'),
    stableNonce: text('stableNonce'),
    command: text('command'),
    cwd: text('cwd'),
    commandDigest: digest,
    spoolLocator: locator,
    createdAt: text('createdAt')
  };
}

async function abortBlockedChild(
  childPid: string,
  exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
): Promise<void> {
  try {
    process.kill(-Number(childPid), 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  await exitPromise.catch(() => undefined);
}

function shellQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}

function writeAtomicJson(filePath: string, value: unknown): void {
  writeAtomicBytes(filePath, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

function writeAtomicBytes(filePath: string, bytes: Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
  const directory = fs.openSync(path.dirname(filePath), 'r');
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_048);
}

function removeIfExists(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
