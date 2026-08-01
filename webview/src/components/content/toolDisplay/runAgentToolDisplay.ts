import { IconMessage2, IconUsers } from '@tabler/icons-vue';
import { bridge, BridgeMessageType } from '@webview/transport';
import type { ToolDisplayContext, ToolDisplayResolver, ToolDisplaySection } from './types';
import { answerFromValue, answerMarkdownSection } from './agentAnswerToolDisplay';

export const runAgentToolDisplay: ToolDisplayResolver = (context) => {
  const conversationId = conversationIdFromRunAgentContext(context);
  const answer = answerFromValue(context.result);
  const metadataSections = runAgentMetadataSections(context);
  const outputSections = metadataSections.length > 0 || answer?.content
    ? [
        ...metadataSections,
        ...(answer?.content ? [answerMarkdownSection(answer.title ?? 'Agent 回答正文', answer.content)] : [])
      ]
    : undefined;

  return {
    headerIcon: IconUsers,
    ...(outputSections ? { outputSections } : {}),
    headerActions: conversationId ? [{
        id: 'open-agent-run-conversation',
        label: '打开对话',
        title: '打开这个 ChildExecution 对应的聊天标签页',
        icon: IconMessage2,
        invoke: () => {
          bridge.request(BridgeMessageType.ConversationOpen, { conversationId });
        }
      }]
      : []
  };
};

function runAgentMetadataSections(context: ToolDisplayContext): ToolDisplaySection[] {
  const record = asRecord(context.result) ?? asRecord(context.progress);
  if (!record) return [];
  const answer = asRecord(record.answer);
  const rows = [
    ...row('childExecutionState', record.childExecutionState),
    ...row('activeChildTurnState', record.activeChildTurnState),
    ...row('answerSubmissionState', record.answerSubmissionState),
    ...row('runtimeDeliveryState', record.runtimeDeliveryState),
    ...row('parentHandlingState', record.parentHandlingState),
    ...row('terminationState', record.terminationState),
    ...row('answerBridgeId', record.answerBridgeId ?? answer?.answerBridgeId)
  ];
  return rows.length > 0
    ? [{ kind: 'output', title: '运行结果', rows, rowStyle: 'keyValue' }]
    : [];
}

function row(label: string, value: unknown): Array<{ label: string; value: string }> {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const text = value.trim();
    return text ? [{ label, value: text }] : [];
  }
  if (typeof value === 'number' || typeof value === 'boolean') return [{ label, value: String(value) }];
  try {
    return [{ label, value: JSON.stringify(value) }];
  } catch {
    return [{ label, value: String(value) }];
  }
}

function conversationIdFromRunAgentContext(context: ToolDisplayContext): string | undefined {
  return conversationIdFromValue(context.result) ?? conversationIdFromValue(context.progress);
}

function conversationIdFromValue(value: unknown): string | undefined {
  const record = asRecord(value);
  const conversationId = record?.childConversationId ?? record?.conversationId;
  return typeof conversationId === 'string' && conversationId.trim() ? conversationId.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
