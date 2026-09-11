import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { readProcessStartFingerprint } from './processProtocol';

export type RecordedProcessState = 'alive' | 'dead' | 'unknown';

/**
 * Classifies a recorded peer process without any timeout-based judgement. Only ESRCH or a
 * verified process-start fingerprint mismatch prove that the recorded identity is dead or reused;
 * every other OS result (including EPERM) leaves the owner unknown so callers fail closed.
 */
export function classifyRecordedProcess(
  processId: number,
  processStartIdentity: string | undefined
): RecordedProcessState {
  if (!Number.isSafeInteger(processId) || processId <= 0) return 'unknown';
  try {
    process.kill(processId, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ESRCH' ? 'dead' : 'unknown';
  }
  if (processStartIdentity === undefined) return 'alive';
  let currentIdentity: string;
  try {
    currentIdentity = readProcessStartFingerprint(processId);
  } catch {
    return 'unknown';
  }
  return currentIdentity === processStartIdentity ? 'alive' : 'dead';
}

let ownStartIdentity: string | undefined;
let ownStartIdentityComputed = false;

/** This host's verified start identity, spawned platform probes run at most once per process. */
export function ownProcessStartIdentity(): string | undefined {
  if (!ownStartIdentityComputed) {
    ownStartIdentityComputed = true;
    try {
      ownStartIdentity = readProcessStartFingerprint(process.pid);
    } catch {
      ownStartIdentity = undefined;
    }
  }
  return ownStartIdentity;
}

/** Deterministic generation sibling path used for dead-owner tombstones and release staging. */
export function claimGenerationPath(claimPath: string, generation: string): string {
  return `${claimPath}.generation-${generation.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/**
 * Publishes one claim record atomically: a candidate directory receives the record and is then
 * renamed onto the canonical path. The canonical directory is always non-empty once published,
 * so a POSIX rename may only silently replace a pathological empty (invalid) directory, never a
 * valid claim. Returns false when a canonical claim already exists.
 */
export async function tryPublishClaimRecord(
  claimPath: string,
  recordFileName: string,
  serializedRecord: string
): Promise<boolean> {
  // A pre-existing canonical path — even an empty directory, which a POSIX rename would
  // silently replace — is contention. Returning false routes it through the caller's strict
  // read, which fails closed on any directory without a valid record.
  try {
    await fs.lstat(claimPath);
    return false;
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
  const candidatePath = `${claimPath}.candidate-${randomUUID()}`;
  await fs.rm(candidatePath, { recursive: true, force: true });
  await fs.mkdir(candidatePath, { mode: 0o700 });
  let published = false;
  try {
    await fs.writeFile(
      `${candidatePath}/${recordFileName}`,
      serializedRecord,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' }
    );
    await fs.rename(candidatePath, claimPath);
    published = true;
    return true;
  } catch (error) {
    if (await isClaimContention(error, claimPath)) return false;
    throw error;
  } finally {
    if (!published) await fs.rm(candidatePath, { recursive: true, force: true });
  }
}

/**
 * Reads and strictly parses a claim record. Returns undefined only when the canonical directory
 * genuinely disappeared (a completed release/isolation race). An existing directory whose record
 * is missing, unreadable or malformed fails closed through the caller's invalid-error factory.
 */
export async function readClaimRecord<T>(
  claimPath: string,
  recordFileName: string,
  parse: (value: unknown) => T | undefined,
  invalid: (cause?: unknown) => Error
): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(`${claimPath}/${recordFileName}`, 'utf8');
  } catch (error) {
    if (isMissingError(error)) {
      // Only a genuinely missing canonical path is a completed release/isolation race; every
      // other lstat failure surfaces instead of being swallowed as "missing".
      try {
        await fs.lstat(claimPath);
      } catch (statError) {
        if (isMissingError(statError)) return undefined;
        throw statError;
      }
      throw invalid(error);
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw invalid(error);
  }
  const record = parse(value);
  if (record === undefined) throw invalid();
  return record;
}

/**
 * Moves a proven-dead claim to its deterministic non-empty tombstone. The record is re-read
 * immediately before the rename so a contender acting on a stale observation can never rename or
 * remove a newer valid owner; the tombstone is left in place (never deleted) so concurrent stale
 * contenders collide on EEXIST instead of moving a newer claim.
 */
export async function isolateDeadClaimRecord<T extends { ownerToken: string }>(
  claimPath: string,
  recordFileName: string,
  ownerToken: string,
  parse: (value: unknown) => T | undefined,
  invalid: (cause?: unknown) => Error
): Promise<void> {
  const current = await readClaimRecord(claimPath, recordFileName, parse, invalid);
  if (!current || current.ownerToken !== ownerToken) return;
  const isolatedPath = claimGenerationPath(claimPath, `dead-${ownerToken}`);
  try {
    await fs.rename(claimPath, isolatedPath);
  } catch (error) {
    if (isMissingError(error) || isAlreadyExistsError(error)) return;
    throw error;
  }
  const moved = await readClaimRecord(isolatedPath, recordFileName, parse, invalid).catch(() => undefined);
  if (!moved || moved.ownerToken !== ownerToken) {
    // The rename moved something other than the observed dead record. That state is impossible
    // while every writer follows this protocol, so it fails closed and loud rather than
    // guessing at a restore or silently continuing.
    throw invalid();
  }
}

/**
 * Exact-token release: the canonical record must still belong to ownerToken before it is moved
 * aside and removed. A missing canonical directory is treated as an already-completed release; a
 * record owned by a different token is never touched and fails closed through mismatch().
 */
export async function releaseClaimRecord<T extends { ownerToken: string }>(
  claimPath: string,
  recordFileName: string,
  ownerToken: string,
  parse: (value: unknown) => T | undefined,
  invalid: (cause?: unknown) => Error,
  mismatch: () => Error
): Promise<void> {
  const current = await readClaimRecord(claimPath, recordFileName, parse, invalid);
  if (!current) return;
  if (current.ownerToken !== ownerToken) throw mismatch();
  const releasedPath = claimGenerationPath(claimPath, `released-${ownerToken}`);
  await fs.rename(claimPath, releasedPath);
  await fs.rm(releasedPath, { recursive: true, force: true });
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function requireNonEmptyText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value;
}

export function isMissingError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

export function isAlreadyExistsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}

async function isClaimContention(error: unknown, claimPath: string): Promise<boolean> {
  if (isAlreadyExistsError(error)) return true;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (process.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES')) return false;
  try {
    return (await fs.stat(claimPath)).isDirectory();
  } catch {
    return false;
  }
}
