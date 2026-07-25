import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import { LlmRequest, Message, Streaming } from '../chat/components';
import { LlmInvocation } from '../llm/components';

export type RunLlmCleanupReasonKind =
  | 'paused'
  | 'user_cancelled'
  | 'stale'
  | 'retry_replaced'
  | 'regenerate_replaced'
  | 'new_message_replaced'
  | 'source_edit_cancelled'
  | 'source_edit_stale';

export interface RunLlmCleanupReason {
  kind: RunLlmCleanupReasonKind;
}

/**
 * 终止某个 Run 关联的全部 LLM request。Message.content 仅保留模型实际输出，
 * 运行状态由独立 Run facts 表达，不再向内容追加提示文本或写 Message.stopReason。
 */
export function cleanupRunLlmRequests(world: WorldReader, cmd: CommandSink, run: Entity, reason: RunLlmCleanupReason): void {
  for (const request of world.query(LlmRequest)) {
    const data = world.get(request, LlmRequest);
    if (!data || data.run !== run) continue;

    cmd.effect({ kind: 'llm.abort', requestId: data.id });

    const modelMessage = world.get(data.modelMessage, Message);
    if (modelMessage) {
      cmd.add(data.modelMessage, Message, {
        ...modelMessage,
        status: 'partial'
      });
    }

    if (data.invocation !== undefined) {
      const invocation = world.get(data.invocation, LlmInvocation);
      if (invocation) {
        cmd.add(data.invocation, LlmInvocation, {
          ...invocation,
          status: 'cancelled',
          completedAt: Date.now(),
          error: reason.kind
        });
      }
    }

    cmd.remove(data.modelMessage, Streaming);
    cmd.despawn(request);
  }
}
