import type { ReliableKernelBoundedClientState } from '@shared/reliableKernelClientFeed';

type Records = ReliableKernelBoundedClientState['records'];

export type ReliableChildAgentGroup = 'executing' | 'resumable' | 'finished' | 'attention';

export interface ReliableChildAgentStatus {
  id: string;
  conversationId: string;
  sourceToolCallId: string;
  agentName: string;
  lifecycle: string;
  lifecycleLabel: string;
  group: ReliableChildAgentGroup;
  activityKind?: string;
  activitySummary?: string;
  interruptible: boolean;
  deliveryBadge?: 'awaiting_parent' | 'delivery_failed';
}

export interface ReliableAgentStatusProjection {
  currentAgentName: string;
  children: ReliableChildAgentStatus[];
}

/** Projects direct children only; lifecycle and delivery remain orthogonal facts. */
export function projectReliableAgentStatus(input: {
  conversationId: string;
  records: Records;
  agentNames: ReadonlyMap<string, string>;
}): ReliableAgentStatusProjection {
  const { conversationId, records } = input;
  const turns = Object.values(records.Turn ?? {});
  const parentTurnIds = new Set(turns
    .filter((turn) => turn.conversation_id === conversationId)
    .map((turn) => stringValue(turn.id))
    .filter((id): id is string => Boolean(id)));
  const agentLinks = Object.values(records.AgentConversationLink ?? {});
  const currentAgentName = agentNameForConversation(conversationId, agentLinks, input.agentNames) ?? 'Agent';
  const childrenById = new Map(Object.values(records.ChildExecution ?? {})
    .flatMap((child) => stringValue(child.id) ? [[stringValue(child.id)!, child] as const] : []));
  const bridgesByChild = new Map(Object.values(records.AnswerBridge ?? {})
    .flatMap((bridge) => stringValue(bridge.child_execution_id)
      ? [[stringValue(bridge.child_execution_id)!, bridge] as const]
      : []));
  const inboxBySubmission = new Map(Object.values(records.RuntimeInboxItem ?? {})
    .filter((inbox) => inbox.source_kind === 'answer_submission')
    .flatMap((inbox) => stringValue(inbox.source_id) ? [[stringValue(inbox.source_id)!, inbox] as const] : []));
  const deliveries = Object.values(records.RuntimeDelivery ?? {});
  const activitiesByChild = new Map(Object.values(records.ChildExecutionActivity ?? {})
    .flatMap((activity) => stringValue(activity.child_execution_id)
      ? [[stringValue(activity.child_execution_id)!, activity] as const]
      : []));

  const children = Object.values(records.ChildExecutionParentLink ?? {}).flatMap((link) => {
    const parentTurnId = stringValue(link.parent_turn_id);
    const childId = stringValue(link.child_execution_id);
    const sourceToolCallId = stringValue(link.source_tool_call_id);
    if (!parentTurnId || !parentTurnIds.has(parentTurnId) || !childId || !sourceToolCallId) return [];
    const child = childrenById.get(childId);
    const childConversationId = stringValue(child?.child_conversation_id);
    const lifecycle = stringValue(child?.status);
    if (!child || !childConversationId || !lifecycle) return [];
    const activity = activitiesByChild.get(childId);
    const activityKind = stringValue(activity?.kind);
    const activitySummary = stringValue(activity?.summary);
    const projectedLifecycle = lifecycleProjection(lifecycle, activityKind);
    const bridge = bridgesByChild.get(childId);
    const submissionId = stringValue(bridge?.current_submission_id);
    const inboxId = submissionId ? stringValue(inboxBySubmission.get(submissionId)?.id) : undefined;
    const delivery = inboxId
      ? deliveries
          .filter((candidate) => candidate.inbox_item_id === inboxId)
          .sort(compareDelivery)[0]
      : undefined;
    const deliveryBadge = deliveryBadgeFor(delivery);
    return [{
      id: childId,
      conversationId: childConversationId,
      sourceToolCallId,
      agentName: agentNameForConversation(childConversationId, agentLinks, input.agentNames) ?? '子 Agent',
      lifecycle,
      interruptible: ['starting', 'active', 'idle'].includes(lifecycle),
      ...projectedLifecycle,
      ...(activityKind ? { activityKind } : {}),
      ...(activitySummary ? { activitySummary } : {}),
      ...(deliveryBadge ? { deliveryBadge } : {})
    } satisfies ReliableChildAgentStatus];
  }).sort((left, right) => left.agentName.localeCompare(right.agentName, 'zh-CN') || left.id.localeCompare(right.id));

  return { currentAgentName, children };
}

function lifecycleProjection(
  lifecycle: string,
  activityKind?: string
): Pick<ReliableChildAgentStatus, 'group' | 'lifecycleLabel'> {
  if (lifecycle === 'idle' && activityKind && !['idle', 'stopping'].includes(activityKind)) {
    return { group: 'executing', lifecycleLabel: '下级子 Agent 仍在运行' };
  }
  switch (lifecycle) {
    case 'starting': return { group: 'executing', lifecycleLabel: '启动中' };
    case 'active': return { group: 'executing', lifecycleLabel: '执行中' };
    case 'interrupting': return { group: 'executing', lifecycleLabel: '正在中断' };
    case 'idle': return { group: 'resumable', lifecycleLabel: '可继续' };
    case 'interrupted': return { group: 'resumable', lifecycleLabel: '已中断' };
    case 'closed': return { group: 'finished', lifecycleLabel: '已结束' };
    case 'needs_human': return { group: 'attention', lifecycleLabel: '需要处理' };
    default: return { group: 'resumable', lifecycleLabel: lifecycle };
  }
}

function deliveryBadgeFor(delivery: Record<string, unknown> | undefined): ReliableChildAgentStatus['deliveryBadge'] {
  if (!delivery) return undefined;
  if (delivery.state === 'failed') return 'delivery_failed';
  if (delivery.state === 'pending') return 'awaiting_parent';
  return delivery.state === 'consumed' && delivery.parent_handling_state === 'unhandled'
    ? 'awaiting_parent'
    : undefined;
}

function agentNameForConversation(
  conversationId: string,
  links: Array<Record<string, unknown>>,
  agentNames: ReadonlyMap<string, string>
): string | undefined {
  const link = links.find((candidate) =>
    candidate.conversation_id === conversationId && candidate.role === 'default'
  ) ?? links.find((candidate) => candidate.conversation_id === conversationId);
  const agentId = stringValue(link?.agent_id);
  return agentId ? agentNames.get(agentId) ?? agentId : undefined;
}

function compareDelivery(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftAttempt = decimal(left.attempt_seq);
  const rightAttempt = decimal(right.attempt_seq);
  if (leftAttempt !== rightAttempt) return leftAttempt > rightAttempt ? -1 : 1;
  return String(right.updated_at ?? '').localeCompare(String(left.updated_at ?? ''));
}

function decimal(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : 0n;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
