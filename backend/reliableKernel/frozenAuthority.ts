import { ContentAddressedStore, type ContentObjectMetadata } from './contentAddressedStore';
import { normalizePlainJson, type PlainJsonValue } from './plainJson';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { RuntimeDatabase } from './runtimeDatabase';

export interface FrozenContextProfile {
  compressionThresholdTokens: number;
  tokenEstimator: {
    kind: 'utf8-bytes-ceil';
    bytesPerToken: number;
  };
}

export interface FrozenTurnAuthority {
  snapshot: DomainRow;
  turn: DomainRow;
  document: PlainJsonValue;
  turnId: string;
  conversationId: string;
}

export async function readFrozenTurnAuthority(
  database: RuntimeDatabase,
  contentStore: ContentAddressedStore,
  authoritySnapshotId: string,
  expectedTurnId?: string
): Promise<FrozenTurnAuthority> {
  const snapshotRead = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('AuthoritySnapshot').get(requireId(authoritySnapshotId, 'authoritySnapshotId'))
  ]);
  const snapshot = requireRow(snapshotRead.snapshot[0], `AuthoritySnapshot ${authoritySnapshotId}`);
  const turnId = requireId(snapshot.turn_id, 'AuthoritySnapshot.turn_id');
  if (expectedTurnId !== undefined && turnId !== requireId(expectedTurnId, 'expectedTurnId')) {
    throw new Error('AuthoritySnapshot belongs to another Turn.');
  }
  const linked = await database.snapshot([
    DOMAIN_REPOSITORIES.domain('ContentObject').get(requireId(
      snapshot.content_object_id,
      'AuthoritySnapshot.content_object_id'
    )),
    DOMAIN_REPOSITORIES.domain('Turn').get(turnId)
  ]);
  const contentObject = requireRow(linked.snapshot[0], `AuthoritySnapshot ${authoritySnapshotId} ContentObject`);
  const turn = requireRow(linked.snapshot[1], `Turn ${turnId}`);
  const bytes = await contentStore.read(contentObject as ContentObjectMetadata);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(
      `AuthoritySnapshot ${authoritySnapshotId} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return {
    snapshot,
    turn,
    document: normalizePlainJson(parsed, `AuthoritySnapshot ${authoritySnapshotId}`),
    turnId,
    conversationId: requireId(turn.conversation_id, 'Turn.conversation_id')
  };
}

export function frozenModelIdentity(document: PlainJsonValue): { providerId: string; modelId: string } {
  if (!isRecord(document) || !isRecord(document.model)) {
    throw new Error('AuthoritySnapshot is missing frozen model identity.');
  }
  return {
    providerId: requireText(document.model.providerConfigId, 'AuthoritySnapshot.model.providerConfigId'),
    modelId: requireText(document.model.modelId, 'AuthoritySnapshot.model.modelId')
  };
}

export function frozenContextProfile(document: PlainJsonValue): FrozenContextProfile {
  if (!isRecord(document) || !isRecord(document.modelProfile)) {
    throw new Error('AuthoritySnapshot is missing frozen modelProfile context settings.');
  }
  const threshold = document.modelProfile.compressionThresholdTokens;
  const estimator = document.modelProfile.tokenEstimator;
  if (!Number.isSafeInteger(threshold) || (threshold as number) <= 0) {
    throw new Error('Frozen modelProfile.compressionThresholdTokens must be a positive integer.');
  }
  if (
    !isRecord(estimator)
    || estimator.kind !== 'utf8-bytes-ceil'
    || !Number.isSafeInteger(estimator.bytesPerToken)
    || (estimator.bytesPerToken as number) <= 0
  ) throw new Error('Frozen modelProfile token estimator is unsupported or incomplete.');
  return {
    compressionThresholdTokens: threshold as number,
    tokenEstimator: {
      kind: 'utf8-bytes-ceil',
      bytesPerToken: estimator.bytesPerToken as number
    }
  };
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string.`);
  return value;
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty.`);
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
