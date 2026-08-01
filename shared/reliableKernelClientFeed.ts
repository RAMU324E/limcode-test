import {
  toStructuredClonePlainData,
  type PlainData
} from './plainData';

export const RELIABLE_KERNEL_SNAPSHOT_MESSAGE = 'reliable-kernel.snapshot';
export const RELIABLE_KERNEL_CHANGES_MESSAGE = 'reliable-kernel.changes';
export const RELIABLE_KERNEL_ACK_MESSAGE = 'reliable-kernel.ack';
export const RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE = 'reliable-kernel.snapshot-request';

export interface ReliableKernelClientChange {
  type: string;
  operation: 'upsert' | 'remove';
  id: string;
  record?: { [key: string]: PlainData };
}

export interface ReliableKernelSnapshotMessage {
  type: typeof RELIABLE_KERNEL_SNAPSHOT_MESSAGE;
  sessionId: string;
  hostBootId: string;
  messageSeq: string;
  snapshotCommitSeq: string;
  projections: { [key: string]: PlainData };
}

export interface ReliableKernelChangesMessage {
  type: typeof RELIABLE_KERNEL_CHANGES_MESSAGE;
  sessionId: string;
  hostBootId: string;
  messageSeq: string;
  commitSeq: string;
  changes: ReliableKernelClientChange[];
}

export interface ReliableKernelAckMessage {
  type: typeof RELIABLE_KERNEL_ACK_MESSAGE;
  sessionId: string;
  hostBootId: string;
  messageSeq: string;
}

export interface ReliableKernelSnapshotRequestMessage {
  type: typeof RELIABLE_KERNEL_SNAPSHOT_REQUEST_MESSAGE;
  sessionId?: string;
  activeConversationId?: string;
}

export type ReliableKernelDataMessage = ReliableKernelSnapshotMessage | ReliableKernelChangesMessage;

export interface ReliableKernelBoundedClientState {
  sessionId: string | null;
  hostBootId: string | null;
  lastCommitSeq: string | null;
  projections: { [key: string]: PlainData };
  records: Record<string, Record<string, { [key: string]: PlainData }>>;
  snapshotRequired: boolean;
}

export interface ReliableKernelClientApplyResult {
  state: ReliableKernelBoundedClientState;
  ack?: ReliableKernelAckMessage;
  snapshotRequired: boolean;
  reason?: 'host-boot-mismatch' | 'session-mismatch' | 'commit-gap' | 'unknown-change-type' | 'apply-failed';
}

export const RELIABLE_KERNEL_CLIENT_CHANGE_TYPES = new Set([
  'Conversation',
  'ConversationReuseLink',
  'ConversationBranchLink',
  'ConversationOriginLink',
  'AgentConversationLink',
  'Turn',
  'ExecutionLease',
  'TurnTermination',
  'TurnExecutorLink',
  'Message',
  'MessageRevision',
  'InteractionRequest',
  'InteractionResponse',
  'ToolCall',
  'ToolExecution',
  'ToolOutcome',
  'ToolModelResult',
  'FileChangeDecision',
  'Process',
  'ProcessReceipt',
  'ModelRequest',
  'ChildExecution',
  'ChildExecutionParentLink',
  'ChildExecutionTurnLink',
  'ChildExecutionActiveTurnLink',
  'AnswerBridge',
  'AnswerSubmission',
  'RuntimeInboxItem',
  'RuntimeDelivery'
] as const);

export function createEmptyReliableKernelClientState(): ReliableKernelBoundedClientState {
  return {
    sessionId: null,
    hostBootId: null,
    lastCommitSeq: null,
    projections: {},
    records: {},
    snapshotRequired: true
  };
}

/**
 * Applies one host data message atomically. Any gap, unknown type or malformed record leaves the
 * prior records untouched and requests a fresh bounded snapshot.
 */
export function applyReliableKernelDataMessage(
  current: ReliableKernelBoundedClientState,
  messageInput: unknown
): ReliableKernelClientApplyResult {
  let message: ReliableKernelDataMessage;
  try {
    message = toStructuredClonePlainData(messageInput, 'client feed message') as unknown as ReliableKernelDataMessage;
  } catch {
    return requireSnapshot(current, 'apply-failed');
  }
  if (message.type === RELIABLE_KERNEL_SNAPSHOT_MESSAGE) {
    try {
      requireId(message.sessionId, 'snapshot.sessionId');
      requireId(message.hostBootId, 'snapshot.hostBootId');
      requireDecimal(message.messageSeq, 'snapshot.messageSeq');
      requireDecimal(message.snapshotCommitSeq, 'snapshot.snapshotCommitSeq');
      if (!message.projections || typeof message.projections !== 'object' || Array.isArray(message.projections)) {
        throw new TypeError('snapshot.projections must be an object.');
      }
      const projections = toStructuredClonePlainData(message.projections, 'snapshot.projections') as {
        [key: string]: PlainData;
      };
      const state: ReliableKernelBoundedClientState = {
        sessionId: message.sessionId,
        hostBootId: message.hostBootId,
        lastCommitSeq: message.snapshotCommitSeq,
        projections,
        records: seedRecordsFromSnapshot(projections),
        snapshotRequired: false
      };
      return {
        state,
        snapshotRequired: false,
        ack: ackFor(message)
      };
    } catch {
      return requireSnapshot(current, 'apply-failed');
    }
  }
  if (message.type !== RELIABLE_KERNEL_CHANGES_MESSAGE) return requireSnapshot(current, 'unknown-change-type');
  if (current.hostBootId !== message.hostBootId) return requireSnapshot(current, 'host-boot-mismatch');
  if (current.sessionId !== message.sessionId) return requireSnapshot(current, 'session-mismatch');
  try {
    requireDecimal(message.messageSeq, 'changes.messageSeq');
    const commitSeq = requireDecimal(message.commitSeq, 'changes.commitSeq');
    const expected = BigInt(requireDecimal(current.lastCommitSeq, 'state.lastCommitSeq')) + 1n;
    if (BigInt(commitSeq) !== expected) return requireSnapshot(current, 'commit-gap');
    if (!Array.isArray(message.changes)) throw new TypeError('changes.changes must be an array.');
    const nextRecords: ReliableKernelBoundedClientState['records'] = { ...current.records };
    const copiedTypes = new Set<string>();
    for (const change of message.changes) {
      if (!change || typeof change !== 'object' || Array.isArray(change)) throw new TypeError('Client change is invalid.');
      if (!RELIABLE_KERNEL_CLIENT_CHANGE_TYPES.has(change.type as never)) {
        return requireSnapshot(current, 'unknown-change-type');
      }
      const id = requireId(change.id, 'change.id');
      if (change.operation !== 'upsert' && change.operation !== 'remove') {
        throw new TypeError('Client change operation is invalid.');
      }
      if (!copiedTypes.has(change.type)) {
        nextRecords[change.type] = { ...(nextRecords[change.type] ?? {}) };
        copiedTypes.add(change.type);
      }
      if (change.operation === 'remove') {
        delete nextRecords[change.type][id];
        continue;
      }
      if (!change.record || typeof change.record !== 'object' || Array.isArray(change.record)) {
        throw new TypeError('Client upsert requires a record.');
      }
      const record = toStructuredClonePlainData(change.record, `change.${change.type}.${id}`) as {
        [key: string]: PlainData;
      };
      if (record.id !== id) throw new TypeError('Client upsert record id does not match change identity.');
      nextRecords[change.type][id] = record;
    }
    const state: ReliableKernelBoundedClientState = {
      ...current,
      lastCommitSeq: commitSeq,
      records: nextRecords,
      snapshotRequired: false
    };
    return { state, snapshotRequired: false, ack: ackFor(message) };
  } catch {
    return requireSnapshot(current, 'apply-failed');
  }
}

function seedRecordsFromSnapshot(
  projections: { [key: string]: PlainData }
): ReliableKernelBoundedClientState['records'] {
  const records: ReliableKernelBoundedClientState['records'] = {};
  const arrayKeyToType: Record<string, string> = {
    conversations: 'Conversation',
    conversationReuseLinks: 'ConversationReuseLink',
    conversationBranchLinks: 'ConversationBranchLink',
    conversationOriginLinks: 'ConversationOriginLink',
    turns: 'Turn',
    executionLeases: 'ExecutionLease',
    turnTerminations: 'TurnTermination',
    turnExecutorLinks: 'TurnExecutorLink',
    toolCalls: 'ToolCall',
    toolExecutions: 'ToolExecution',
    toolOutcomes: 'ToolOutcome',
    interactionRequests: 'InteractionRequest',
    interactionResponses: 'InteractionResponse',
    processes: 'Process',
    processReceipts: 'ProcessReceipt',
    modelRequests: 'ModelRequest',
    childExecutions: 'ChildExecution',
    childExecutionParentLinks: 'ChildExecutionParentLink',
    childExecutionTurnLinks: 'ChildExecutionTurnLink',
    childExecutionActiveTurnLinks: 'ChildExecutionActiveTurnLink',
    answerBridges: 'AnswerBridge',
    answerSubmissions: 'AnswerSubmission',
    runtimeInboxItems: 'RuntimeInboxItem',
    runtimeDeliveries: 'RuntimeDelivery'
  };
  const visit = (value: PlainData): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, nested] of Object.entries(value)) {
      const type = arrayKeyToType[key];
      if (type && Array.isArray(nested)) {
        const bucket = (records[type] ??= {});
        for (const entry of nested) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
          const id = (entry as Record<string, PlainData>).id;
          if (typeof id === 'string' && id) bucket[id] = entry as { [key: string]: PlainData };
        }
      }
      visit(nested);
    }
  };
  visit(projections);
  return records;
}

function requireSnapshot(
  current: ReliableKernelBoundedClientState,
  reason: NonNullable<ReliableKernelClientApplyResult['reason']>
): ReliableKernelClientApplyResult {
  const discardPriorHost = reason === 'host-boot-mismatch' || reason === 'session-mismatch';
  return {
    state: discardPriorHost
      ? createEmptyReliableKernelClientState()
      : { ...current, snapshotRequired: true },
    snapshotRequired: true,
    reason
  };
}

function ackFor(message: ReliableKernelDataMessage): ReliableKernelAckMessage {
  return {
    type: RELIABLE_KERNEL_ACK_MESSAGE,
    sessionId: message.sessionId,
    hostBootId: message.hostBootId,
    messageSeq: message.messageSeq
  };
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value;
}

function requireDecimal(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new TypeError(`${label} must be a decimal integer string.`);
  }
  return value;
}
