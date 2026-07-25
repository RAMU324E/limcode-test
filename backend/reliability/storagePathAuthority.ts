import {
  ANSWER_BRIDGE_LINKS_RESOURCE_KEY,
  CONVERSATION_ATTACHMENTS_RESOURCE_KEY,
  TOOL_RESULT_BLOBS_RESOURCE_KEY
} from '../../shared/conversationReliability';
import type { ConversationId } from '../../shared/stableIds';
import { conversationShardName } from '../capabilities/vscodeStorage/naming';
import type { DurableFileSystem } from './fileDurability';

/**
 * Every file managed by the reliable conversation subsystem belongs to exactly one durability
 * class. The class determines whether a Storage HEAD must own it and which writer may publish it.
 */
export type StorageDurabilityClass =
  | 'authoritative-mutable'
  | 'derived-projection'
  | 'immutable-content'
  | 'transaction-control';

export type ConversationStorageDomain =
  | 'runtime'
  | 'timeline'
  | 'compression'
  | 'tool_calls'
  | 'tool_events'
  | 'tool_results'
  | 'interactions'
  | 'turns'
  | 'turn_intents'
  | 'execution_leases'
  | 'authority'
  | 'runtime_inbox';

export const ATTACHMENT_STORAGE_RESOURCE_KEY = CONVERSATION_ATTACHMENTS_RESOURCE_KEY;
export const ANSWER_BRIDGE_LINKS_STORAGE_RESOURCE_KEY = ANSWER_BRIDGE_LINKS_RESOURCE_KEY;
export const ANSWER_BRIDGE_LINKS_ROOT = 'answer-bridge-links';

export type StorageHeadOwner =
  | {
      kind: 'conversation';
      conversationId: ConversationId;
      domain: ConversationStorageDomain;
    }
  | {
      kind: 'resource';
      resourceKey:
        | typeof ATTACHMENT_STORAGE_RESOURCE_KEY
        | typeof ANSWER_BRIDGE_LINKS_STORAGE_RESOURCE_KEY
        | typeof TOOL_RESULT_BLOBS_RESOURCE_KEY;
    };

export type StorageLiveWriter =
  | 'conversation-transaction-backend'
  | 'derived-projection-writer'
  | 'immutable-content-writer'
  | 'transaction-control-writer';

export interface StoragePathAuthority {
  namespace: string;
  durabilityClass: StorageDurabilityClass;
  owner?: StorageHeadOwner;
}

export interface StorageAuthorityNamespace {
  namespace: string;
  durabilityClass: StorageDurabilityClass;
  owner?: StorageHeadOwner;
  entries: ReadonlyArray<{ path: string; kind: 'file' | 'directory' }>;
}

interface NamespaceRule extends StorageAuthorityNamespace {
  matches(relativePath: string): boolean;
}

const TRANSACTION_ROOT = 'operations/conversation-transitions';
const STREAM_CHECKPOINT_ROOT = 'operations/stream-checkpoints';
const RUNTIME_FILE_NAME = 'runtime-authority.json';
const TIMELINE_ROOT_NAME = 'messages';
const AUTHORITATIVE_COMPRESSION_ROOTS = [
  'compression-blocks',
  'compression-block-source-links',
  'compression-context-variants',
  'compression-block-llm-invocation-links'
] as const;

const TURN_DOMAIN_ROOTS = ['turns', 'child-turn-links', 'message-turn-links'] as const;
const TURN_INTENT_DOMAIN_ROOTS = [
  'turn-intents',
  'turn-intent-revisions',
  'turn-execution-preset-revisions',
  'pending-turn-inputs'
] as const;
const EXECUTION_LEASE_DOMAIN_ROOTS = ['execution-leases'] as const;
const AUTHORITY_DOMAIN_ROOTS = ['authority-snapshots', 'authority-derivation-links'] as const;
const RUNTIME_INBOX_DOMAIN_ROOTS = ['runtime-inbox-items', 'runtime-delivery-links'] as const;

const AUTHORITATIVE_INSPECTION_ENTRIES: ReadonlyArray<{ path: string; kind: 'file' | 'directory' }> = [
  { path: 'conversations/details', kind: 'directory' },
  ...AUTHORITATIVE_COMPRESSION_ROOTS.map((root) => ({ path: `${root}/conversations`, kind: 'directory' as const })),
  { path: 'tool-calls/conversations', kind: 'directory' },
  { path: 'tool-call-events/conversations', kind: 'directory' },
  { path: 'tool-result-artifacts/conversations', kind: 'directory' },
  { path: 'tool-call-result-links/conversations', kind: 'directory' },
  { path: 'interactions/conversations', kind: 'directory' },
  { path: 'interaction-owner-links/conversations', kind: 'directory' },
  { path: 'interaction-responses/conversations', kind: 'directory' },
  ...TURN_DOMAIN_ROOTS.map((root) => ({ path: `${root}/conversations`, kind: 'directory' as const })),
  ...TURN_INTENT_DOMAIN_ROOTS.map((root) => ({ path: `${root}/conversations`, kind: 'directory' as const })),
  ...EXECUTION_LEASE_DOMAIN_ROOTS.map((root) => ({ path: `${root}/conversations`, kind: 'directory' as const })),
  ...AUTHORITY_DOMAIN_ROOTS.map((root) => ({ path: `${root}/conversations`, kind: 'directory' as const })),
  ...RUNTIME_INBOX_DOMAIN_ROOTS.map((root) => ({ path: `${root}/conversations`, kind: 'directory' as const })),
  { path: 'attachments/index.json', kind: 'file' },
  { path: 'attachments/records', kind: 'directory' },
  { path: ANSWER_BRIDGE_LINKS_ROOT, kind: 'directory' }
];

/** The control HEAD carries optimistic version/patch sequencing and never owns business files. */
export function conversationControlHeadKey(conversationId: ConversationId): string {
  return `conversation:${conversationId}:control`;
}

export function conversationDomainHeadKey(
  conversationId: ConversationId,
  domain: ConversationStorageDomain
): string {
  return `conversation:${conversationId}:${domain}`;
}

export function storageResourceHeadKey(resourceKey: string): string {
  const normalized = resourceKey.trim();
  if (!normalized || normalized.includes('/')) throw new Error(`Invalid storage resource key: ${resourceKey}`);
  return `resource:${normalized}`;
}

export function storageHeadKey(owner: StorageHeadOwner): string {
  return owner.kind === 'conversation'
    ? conversationDomainHeadKey(owner.conversationId, owner.domain)
    : storageResourceHeadKey(owner.resourceKey);
}

export function storageHeadOwnerEquals(left: StorageHeadOwner | undefined, right: StorageHeadOwner | undefined): boolean {
  if (!left || !right || left.kind !== right.kind) return left === right;
  return left.kind === 'conversation' && right.kind === 'conversation'
    ? left.conversationId === right.conversationId && left.domain === right.domain
    : left.kind === 'resource' && right.kind === 'resource' && left.resourceKey === right.resourceKey;
}

/**
 * Central registry for all reliable-conversation file namespaces.
 *
 * There is deliberately no single-conversation fallback and no "path contains shard" inference.
 * Dynamic namespaces are materialized from explicit Conversation IDs, and construction rejects a
 * shard collision before any path can be classified.
 */
export class StoragePathAuthorityRegistry {
  private readonly rules: readonly NamespaceRule[];

  public constructor(conversationIds: Iterable<ConversationId> = []) {
    const conversations = [...new Set(conversationIds)].sort();
    assertUniqueConversationShards(conversations);
    this.rules = [
      ...staticNamespaceRules(),
      ...conversations.flatMap(conversationNamespaceRules)
    ];
    assertRulesDoNotDuplicateNamespaces(this.rules);
  }

  public classify(relativePath: string): StoragePathAuthority | undefined {
    const target = normalizeAuthorityRelativePath(relativePath);
    const matches = this.rules.filter((rule) => rule.matches(target));
    if (matches.length > 1) {
      throw new Error(`Storage path belongs to multiple registered namespaces: ${target} (${matches.map((rule) => rule.namespace).join(', ')})`);
    }
    const rule = matches[0];
    return rule
      ? {
          namespace: rule.namespace,
          durabilityClass: rule.durabilityClass,
          ...(rule.owner ? { owner: rule.owner } : {})
        }
      : undefined;
  }

  public requireClassified(relativePath: string): StoragePathAuthority {
    const authority = this.classify(relativePath);
    if (!authority) throw new Error(`Storage path is outside every registered reliability namespace: ${normalizeAuthorityRelativePath(relativePath)}`);
    return authority;
  }

  public requireAuthoritativeOwner(relativePath: string, expectedOwner: StorageHeadOwner): StoragePathAuthority {
    const authority = this.requireClassified(relativePath);
    if (authority.durabilityClass !== 'authoritative-mutable') {
      throw new Error(`Storage path is not authoritative mutable state: ${normalizeAuthorityRelativePath(relativePath)} (${authority.durabilityClass})`);
    }
    if (!storageHeadOwnerEquals(authority.owner, expectedOwner)) {
      throw new Error(`Storage path has the wrong Storage HEAD owner: ${normalizeAuthorityRelativePath(relativePath)} (expected ${storageHeadKey(expectedOwner)}, actual ${authority.owner ? storageHeadKey(authority.owner) : '<none>'})`);
    }
    return authority;
  }

  public assertLiveWriteAllowed(relativePath: string, writer: StorageLiveWriter): StoragePathAuthority {
    const authority = this.requireClassified(relativePath);
    const expectedWriter = writerForDurabilityClass(authority.durabilityClass);
    if (writer !== expectedWriter) {
      throw new Error(`Direct write is forbidden for ${normalizeAuthorityRelativePath(relativePath)}: ${writer} cannot publish ${authority.durabilityClass}; required writer is ${expectedWriter}.`);
    }
    return authority;
  }

  public namespaces(): StorageAuthorityNamespace[] {
    return this.rules.map(({ matches: _matches, ...rule }) => ({
      ...rule,
      entries: rule.entries.map((entry) => ({ ...entry })),
      ...(rule.owner ? { owner: { ...rule.owner } as StorageHeadOwner } : {})
    }));
  }

  public authoritativeNamespacesFor(owner: StorageHeadOwner): StorageAuthorityNamespace[] {
    return this.namespaces().filter((namespace) =>
      namespace.durabilityClass === 'authoritative-mutable'
      && storageHeadOwnerEquals(namespace.owner, owner));
  }

  /** Broad roots used only to discover authoritative files that have no registered owner/HEAD. */
  public authoritativeInspectionEntries(): Array<{ path: string; kind: 'file' | 'directory' }> {
    return AUTHORITATIVE_INSPECTION_ENTRIES.map((entry) => ({ ...entry }));
  }

  /** Enumerates the complete physical namespace owned by one domain/resource HEAD. */
  public async enumerateAuthoritativeTargets(files: DurableFileSystem, owner: StorageHeadOwner): Promise<string[]> {
    const namespaces = this.authoritativeNamespacesFor(owner);
    if (namespaces.length === 0) throw new Error(`Storage HEAD has no registered authoritative namespace: ${storageHeadKey(owner)}`);
    const candidates = new Set<string>();
    for (const namespace of namespaces) {
      for (const entry of namespace.entries) {
        if (entry.kind === 'file') {
          if (await files.hash(entry.path) !== null) candidates.add(entry.path);
          continue;
        }
        for (const target of await files.listFilesRecursive(entry.path)) candidates.add(normalizeAuthorityRelativePath(target));
      }
    }
    const result: string[] = [];
    for (const target of [...candidates].sort()) {
      const authority = this.classify(target);
      if (authority?.durabilityClass === 'authoritative-mutable' && storageHeadOwnerEquals(authority.owner, owner)) {
        result.push(target);
      }
    }
    return result;
  }
}

export function conversationRuntimeRelativePath(conversationId: ConversationId): string {
  return `conversations/details/${conversationShardName(conversationId)}/${RUNTIME_FILE_NAME}`;
}

export function conversationTimelineRootRelativePath(conversationId: ConversationId): string {
  return `conversations/details/${conversationShardName(conversationId)}/${TIMELINE_ROOT_NAME}`;
}

export function conversationCompressionRootRelativePaths(conversationId: ConversationId): string[] {
  const shard = conversationShardName(conversationId);
  return AUTHORITATIVE_COMPRESSION_ROOTS.map((root) => `${root}/conversations/${shard}`);
}

export function conversationToolCallsRootRelativePath(conversationId: ConversationId): string {
  return `tool-calls/conversations/${conversationShardName(conversationId)}`;
}

export function conversationToolCallEventsRootRelativePath(conversationId: ConversationId): string {
  return `tool-call-events/conversations/${conversationShardName(conversationId)}`;
}

export function conversationToolResultArtifactsRootRelativePath(conversationId: ConversationId): string {
  return `tool-result-artifacts/conversations/${conversationShardName(conversationId)}`;
}

export function conversationToolCallResultLinksRootRelativePath(conversationId: ConversationId): string {
  return `tool-call-result-links/conversations/${conversationShardName(conversationId)}`;
}

export function conversationInteractionsRootRelativePath(conversationId: ConversationId): string {
  return `interactions/conversations/${conversationShardName(conversationId)}`;
}

export function conversationControlFamilyRootRelativePath(root: string, conversationId: ConversationId): string {
  const normalized = root.trim();
  const allowed = new Set<string>([
    ...TURN_DOMAIN_ROOTS,
    ...TURN_INTENT_DOMAIN_ROOTS,
    ...EXECUTION_LEASE_DOMAIN_ROOTS,
    ...AUTHORITY_DOMAIN_ROOTS,
    ...RUNTIME_INBOX_DOMAIN_ROOTS,
    'interaction-owner-links',
    'interaction-responses'
  ]);
  if (!allowed.has(normalized)) throw new Error(`Unknown Conversation control family root: ${root}`);
  return `${normalized}/conversations/${conversationShardName(conversationId)}`;
}

export function attachmentRecordsRootRelativePath(): string {
  return 'attachments/records';
}

export function answerBridgeLinksRecordsRootRelativePath(): string {
  return `${ANSWER_BRIDGE_LINKS_ROOT}/records`;
}

function conversationNamespaceRules(conversationId: ConversationId): NamespaceRule[] {
  const runtime = conversationRuntimeRelativePath(conversationId);
  const timeline = conversationTimelineRootRelativePath(conversationId);
  const runtimeOwner: StorageHeadOwner = { kind: 'conversation', conversationId, domain: 'runtime' };
  const timelineOwner: StorageHeadOwner = { kind: 'conversation', conversationId, domain: 'timeline' };
  const compressionOwner: StorageHeadOwner = { kind: 'conversation', conversationId, domain: 'compression' };
  const toolCallsOwner: StorageHeadOwner = { kind: 'conversation', conversationId, domain: 'tool_calls' };
  const toolEventsOwner: StorageHeadOwner = { kind: 'conversation', conversationId, domain: 'tool_events' };
  const toolResultsOwner: StorageHeadOwner = { kind: 'conversation', conversationId, domain: 'tool_results' };
  const interactionsOwner: StorageHeadOwner = { kind: 'conversation', conversationId, domain: 'interactions' };
  const turnsOwner: StorageHeadOwner = { kind: 'conversation', conversationId, domain: 'turns' };
  const turnIntentsOwner: StorageHeadOwner = { kind: 'conversation', conversationId, domain: 'turn_intents' };
  const executionLeasesOwner: StorageHeadOwner = { kind: 'conversation', conversationId, domain: 'execution_leases' };
  const authorityOwner: StorageHeadOwner = { kind: 'conversation', conversationId, domain: 'authority' };
  const runtimeInboxOwner: StorageHeadOwner = { kind: 'conversation', conversationId, domain: 'runtime_inbox' };
  return [
    exactRule(`conversation:${conversationId}:runtime`, 'authoritative-mutable', runtime, runtimeOwner),
    prefixRule(
      `conversation:${conversationId}:timeline`,
      'authoritative-mutable',
      timeline,
      timelineOwner
    ),
    ...conversationCompressionRootRelativePaths(conversationId).map((root) => prefixRule(
      `conversation:${conversationId}:compression:${root.split('/')[0]}`,
      'authoritative-mutable',
      root,
      compressionOwner
    )),
    prefixRule(
      `conversation:${conversationId}:tool-calls`,
      'authoritative-mutable',
      conversationToolCallsRootRelativePath(conversationId),
      toolCallsOwner
    ),
    prefixRule(
      `conversation:${conversationId}:tool-call-events`,
      'authoritative-mutable',
      conversationToolCallEventsRootRelativePath(conversationId),
      toolEventsOwner
    ),
    prefixRule(
      `conversation:${conversationId}:tool-result-artifacts`,
      'authoritative-mutable',
      conversationToolResultArtifactsRootRelativePath(conversationId),
      toolResultsOwner
    ),
    prefixRule(
      `conversation:${conversationId}:tool-call-result-links`,
      'authoritative-mutable',
      conversationToolCallResultLinksRootRelativePath(conversationId),
      toolResultsOwner
    ),
    prefixRule(
      `conversation:${conversationId}:interactions`,
      'authoritative-mutable',
      conversationInteractionsRootRelativePath(conversationId),
      interactionsOwner
    ),
    prefixRule(
      `conversation:${conversationId}:interaction-owner-links`,
      'authoritative-mutable',
      conversationControlFamilyRootRelativePath('interaction-owner-links', conversationId),
      interactionsOwner
    ),
    prefixRule(
      `conversation:${conversationId}:interaction-responses`,
      'authoritative-mutable',
      conversationControlFamilyRootRelativePath('interaction-responses', conversationId),
      interactionsOwner
    ),
    ...TURN_DOMAIN_ROOTS.map((root) => prefixRule(
      `conversation:${conversationId}:${root}`,
      'authoritative-mutable',
      conversationControlFamilyRootRelativePath(root, conversationId),
      turnsOwner
    )),
    ...TURN_INTENT_DOMAIN_ROOTS.map((root) => prefixRule(
      `conversation:${conversationId}:${root}`,
      'authoritative-mutable',
      conversationControlFamilyRootRelativePath(root, conversationId),
      turnIntentsOwner
    )),
    ...EXECUTION_LEASE_DOMAIN_ROOTS.map((root) => prefixRule(
      `conversation:${conversationId}:${root}`,
      'authoritative-mutable',
      conversationControlFamilyRootRelativePath(root, conversationId),
      executionLeasesOwner
    )),
    ...AUTHORITY_DOMAIN_ROOTS.map((root) => prefixRule(
      `conversation:${conversationId}:${root}`,
      'authoritative-mutable',
      conversationControlFamilyRootRelativePath(root, conversationId),
      authorityOwner
    )),
    ...RUNTIME_INBOX_DOMAIN_ROOTS.map((root) => prefixRule(
      `conversation:${conversationId}:${root}`,
      'authoritative-mutable',
      conversationControlFamilyRootRelativePath(root, conversationId),
      runtimeInboxOwner
    ))
  ];
}

function staticNamespaceRules(): NamespaceRule[] {
  const attachmentOwner: StorageHeadOwner = { kind: 'resource', resourceKey: ATTACHMENT_STORAGE_RESOURCE_KEY };
  const answerBridgeOwner: StorageHeadOwner = { kind: 'resource', resourceKey: ANSWER_BRIDGE_LINKS_STORAGE_RESOURCE_KEY };
  return [
    prefixRule('stream-checkpoints', 'immutable-content', STREAM_CHECKPOINT_ROOT),
    prefixRule('conversation-transaction-control', 'transaction-control', TRANSACTION_ROOT, undefined, (target) => !isAtOrBelow(target, STREAM_CHECKPOINT_ROOT)),
    exactRule('attachment-index', 'authoritative-mutable', 'attachments/index.json', attachmentOwner),
    prefixRule('attachment-records', 'authoritative-mutable', attachmentRecordsRootRelativePath(), attachmentOwner),
    prefixRule('attachment-blobs', 'immutable-content', 'attachments/blobs'),
    prefixRule('tool-result-blobs', 'immutable-content', 'tool-result-blobs/sha256'),
    prefixRule('attachment-opened-files', 'derived-projection', 'attachments/opened'),
    exactRule('answer-bridge-link-index', 'authoritative-mutable', `${ANSWER_BRIDGE_LINKS_ROOT}/index.json`, answerBridgeOwner),
    prefixRule('answer-bridge-link-records', 'authoritative-mutable', answerBridgeLinksRecordsRootRelativePath(), answerBridgeOwner),
    prefixRule('conversation-history', 'derived-projection', 'conversation-history')
  ];
}

function exactRule(
  namespace: string,
  durabilityClass: StorageDurabilityClass,
  target: string,
  owner?: StorageHeadOwner
): NamespaceRule {
  const normalized = normalizeAuthorityRelativePath(target);
  return {
    namespace,
    durabilityClass,
    ...(owner ? { owner } : {}),
    entries: [{ path: normalized, kind: 'file' }],
    matches: (candidate) => candidate === normalized
  };
}

function prefixRule(
  namespace: string,
  durabilityClass: StorageDurabilityClass,
  root: string,
  owner?: StorageHeadOwner,
  additionalPredicate: (target: string) => boolean = () => true
): NamespaceRule {
  const normalized = normalizeAuthorityRelativePath(root);
  return {
    namespace,
    durabilityClass,
    ...(owner ? { owner } : {}),
    entries: [{ path: normalized, kind: 'directory' }],
    matches: (candidate) => isAtOrBelow(candidate, normalized) && additionalPredicate(candidate)
  };
}

function writerForDurabilityClass(durabilityClass: StorageDurabilityClass): StorageLiveWriter {
  switch (durabilityClass) {
    case 'authoritative-mutable': return 'conversation-transaction-backend';
    case 'derived-projection': return 'derived-projection-writer';
    case 'immutable-content': return 'immutable-content-writer';
    case 'transaction-control': return 'transaction-control-writer';
  }
}

function assertUniqueConversationShards(conversationIds: readonly ConversationId[]): void {
  const ownerByShard = new Map<string, ConversationId>();
  for (const conversationId of conversationIds) {
    const shard = conversationShardName(conversationId);
    const existing = ownerByShard.get(shard);
    if (existing && existing !== conversationId) {
      throw new Error(`Conversation storage shard collision: ${existing} and ${conversationId} both map to ${shard}.`);
    }
    ownerByShard.set(shard, conversationId);
  }
}

function assertRulesDoNotDuplicateNamespaces(rules: readonly NamespaceRule[]): void {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.namespace)) throw new Error(`Duplicate storage authority namespace: ${rule.namespace}`);
    seen.add(rule.namespace);
  }
}

function isAtOrBelow(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

function normalizeAuthorityRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.endsWith('/')
    || normalized.split('/').some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid storage authority relative path: ${value}`);
  }
  return normalized;
}
