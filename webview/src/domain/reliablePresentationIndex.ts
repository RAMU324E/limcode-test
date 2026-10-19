import type { FunctionCallPart, MessageRecord, ToolCallRecord } from '@shared/protocol';

/** Shared display associations. The committed Link still decides which Message owns a tool. */
export interface ReliablePresentationIndex {
  messageById: ReadonlyMap<string, MessageRecord>;
  messagePositionById: ReadonlyMap<string, number>;
  messageIds: readonly string[];
  messageMetadata: readonly { id: string; role: MessageRecord['role']; createdAt: number }[];
  toolCallById: ReadonlyMap<string, ToolCallRecord>;
  toolCallsByPartIdByMessageId: ReadonlyMap<string, ReadonlyMap<string, ToolCallRecord>>;
  toolCallsByOrdinalByMessageId: ReadonlyMap<string, ReadonlyMap<number, ReadonlyMap<string, ToolCallRecord>>>;
  firstToolCallByNameByMessageId: ReadonlyMap<string, ReadonlyMap<string, ToolCallRecord>>;
  completedToolTurnIds: ReadonlySet<string>;
  /** Timestamp-sorted thresholds carry the last qualifying position in transcript order. */
  compressionPositions: readonly { createdAt: number; position: number }[];
}

export function createReliablePresentationIndex(
  messages: readonly MessageRecord[],
  toolCalls: readonly ToolCallRecord[],
  turnIdByMessageId: Readonly<Record<string, string>> = {},
  previous?: ReliablePresentationIndex,
  committedCompletedTurnIds: Iterable<string> = []
): ReliablePresentationIndex {
  const messageById = new Map<string, MessageRecord>();
  const messagePositionById = new Map<string, number>();
  const messageIds: string[] = [];
  const compressionPositions: Array<{ createdAt: number; position: number }> = [];
  messages.forEach((message, position) => {
    messageById.set(message.id, message);
    messagePositionById.set(message.id, position);
    messageIds.push(message.id);
    if (message.createdAt > 0) compressionPositions.push({ createdAt: message.createdAt, position });
  });
  compressionPositions.sort((left, right) => left.createdAt - right.createdAt || left.position - right.position);
  let lastPosition = -1;
  for (const entry of compressionPositions) {
    lastPosition = Math.max(lastPosition, entry.position);
    entry.position = lastPosition;
  }

  const toolCallById = new Map<string, ToolCallRecord>();
  const toolCallsByPartIdByMessageId = new Map<string, Map<string, ToolCallRecord>>();
  const toolCallsByOrdinalByMessageId = new Map<string, Map<number, Map<string, ToolCallRecord>>>();
  const firstToolCallByNameByMessageId = new Map<string, Map<string, ToolCallRecord>>();
  const completedToolTurnIds = new Set<string>(committedCompletedTurnIds);
  for (const call of toolCalls) {
    const turnId = turnIdByMessageId[call.messageId];
    if (turnId && (call.status === 'success' || call.status === 'warning' || call.status === 'error')) {
      completedToolTurnIds.add(turnId);
    }
    toolCallById.set(call.id, call);
    const parts = toolCallsByPartIdByMessageId.get(call.messageId) ?? new Map<string, ToolCallRecord>();
    if (!parts.has(call.id)) parts.set(call.id, call);
    if (call.functionCallId && !parts.has(call.functionCallId)) parts.set(call.functionCallId, call);
    toolCallsByPartIdByMessageId.set(call.messageId, parts);
    const names = firstToolCallByNameByMessageId.get(call.messageId) ?? new Map<string, ToolCallRecord>();
    if (!names.has(call.name)) names.set(call.name, call);
    firstToolCallByNameByMessageId.set(call.messageId, names);
    if (call.schedulingOrdinal !== undefined) {
      const ordinals = toolCallsByOrdinalByMessageId.get(call.messageId) ?? new Map<number, Map<string, ToolCallRecord>>();
      const ordinalNames = ordinals.get(call.schedulingOrdinal) ?? new Map<string, ToolCallRecord>();
      if (!ordinalNames.has(call.name)) ordinalNames.set(call.name, call);
      ordinals.set(call.schedulingOrdinal, ordinalNames);
      toolCallsByOrdinalByMessageId.set(call.messageId, ordinals);
    }
  }
  const sameOrder = previous && messages.length === previous.messageIds.length
    && messages.every((message, position) => message.id === previous.messageIds[position]);
  const sameMetadata = sameOrder && messages.every((message, position) => {
    const metadata = previous.messageMetadata[position];
    return metadata?.role === message.role && metadata.createdAt === message.createdAt;
  });
  return {
    messageById,
    messagePositionById: sameOrder ? previous.messagePositionById : messagePositionById,
    messageIds: sameOrder ? previous.messageIds : messageIds,
    messageMetadata: sameMetadata ? previous.messageMetadata : messages.map(({ id, role, createdAt }) => ({ id, role, createdAt })),
    compressionPositions: sameMetadata ? previous.compressionPositions : compressionPositions,
    toolCallById,
    toolCallsByPartIdByMessageId, toolCallsByOrdinalByMessageId, firstToolCallByNameByMessageId, completedToolTurnIds
  };
}

export function reliableToolCallForPart(
  index: ReliablePresentationIndex,
  messageId: string | undefined,
  part: FunctionCallPart,
  ordinal?: number
): ToolCallRecord | undefined {
  if (!messageId) return undefined;
  const exact = part.id ? index.toolCallsByPartIdByMessageId.get(messageId)?.get(part.id) : undefined;
  if (exact) return exact;
  return ordinal === undefined
    ? index.firstToolCallByNameByMessageId.get(messageId)?.get(part.functionCall.name)
    : index.toolCallsByOrdinalByMessageId.get(messageId)?.get(ordinal)?.get(part.functionCall.name);
}

/** Content changes replace their message lookup only; order and tool associations stay stable. */
export function withReliablePresentationMessages(
  index: ReliablePresentationIndex,
  messages: readonly MessageRecord[]
): ReliablePresentationIndex {
  const sameOrder = messages.length === index.messageIds.length
    && messages.every((message, position) => message.id === index.messageIds[position]);
  const sameTimes = sameOrder && messages.every((message, position) => {
    const metadata = index.messageMetadata[position];
    return metadata?.createdAt === message.createdAt && metadata.role === message.role;
  });
  const messageById = new Map(messages.map(message => [message.id, message]));
  if (sameTimes) return { ...index, messageById };
  const positions = createReliablePresentationIndex(messages, []);
  return { ...index, messageById, messagePositionById: positions.messagePositionById,
    messageIds: positions.messageIds, messageMetadata: positions.messageMetadata, compressionPositions: positions.compressionPositions };
}

export type ReliableMessageOrderIndex = Pick<ReliablePresentationIndex, 'messageIds' | 'messagePositionById' | 'compressionPositions'>;

export function reliableCompressionAnchorAt(index: ReliableMessageOrderIndex, createdAt: number): string | undefined {
  let lower = 0;
  let upper = index.compressionPositions.length;
  while (lower < upper) {
    const middle = (lower + upper) >>> 1;
    if (index.compressionPositions[middle]!.createdAt <= createdAt) lower = middle + 1;
    else upper = middle;
  }
  const position = index.compressionPositions[lower - 1]?.position;
  return position === undefined ? undefined : index.messageIds[position];
}

/** Content-only frames override a few existing rows without copying the historical lookup table. */
export function withReliablePresentationMessageOverrides(
  index: ReliablePresentationIndex,
  messages: ReadonlyMap<string, MessageRecord>
): ReliablePresentationIndex {
  return { ...index, messageById: new ReliableMessageLookup(index.messageById, messages) };
}

class ReliableMessageLookup implements ReadonlyMap<string, MessageRecord> {
  constructor(private readonly base: ReadonlyMap<string, MessageRecord>, private readonly changed: ReadonlyMap<string, MessageRecord>) {}
  get size(): number { return this.base.size; }
  get(key: string): MessageRecord | undefined { return this.changed.get(key) ?? this.base.get(key); }
  has(key: string): boolean { return this.base.has(key); }
  keys() { return this.base.keys(); }
  *values(): Generator<MessageRecord, undefined> { for (const key of this.base.keys()) yield this.get(key)!; return undefined; }
  *entries(): Generator<[string, MessageRecord], undefined> { for (const key of this.base.keys()) yield [key, this.get(key)!]; return undefined; }
  [Symbol.iterator]() { return this.entries(); }
  forEach(callback: (value: MessageRecord, key: string, map: ReadonlyMap<string, MessageRecord>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callback.call(thisArg, value, key, this);
  }
}
