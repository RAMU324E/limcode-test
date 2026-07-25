import type { ConversationId, RunId, ToolCallId } from '../../../shared/stableIds';
import {
  cancellationPolicy,
  type CancellationPolicy,
  type CancellationPolicyName
} from '../../../shared/cancellationPolicy';

export {
  cancellationPolicy,
  runGraphCascadeForPolicy
} from '../../../shared/cancellationPolicy';
export type { CancellationPolicy, CancellationPolicyName } from '../../../shared/cancellationPolicy';

/** Stable user intent identities; handlers resolve one intent before selecting its shared policy. */
export type CancellationIntent =
  | {
      kind: 'tool_operation_cancel';
      conversationId: ConversationId;
      toolCallId: ToolCallId;
    }
  | {
      kind: 'foreground_child_tool_cancel';
      conversationId: ConversationId;
      sourceRunId: RunId;
      sourceToolCallId: ToolCallId;
    }
  | {
      kind: 'answer_bridge_child_interrupt';
      callerConversationId: ConversationId;
      bridgeId: string;
      expectedOwnerGeneration: number;
    }
  | {
      kind: 'conversation_stop';
      conversationId: ConversationId;
      rootRunId?: RunId;
    }
  | {
      kind: 'run_tree_stop';
      conversationId: ConversationId;
      rootRunId: RunId;
    }
  | {
      kind: 'run_replacement';
      conversationId: ConversationId;
      rootRunId: RunId;
      reasonCode: string;
    };

export function cancellationPolicyForIntent(intent: CancellationIntent): CancellationPolicy {
  switch (intent.kind) {
    case 'tool_operation_cancel': return cancellationPolicy('ordinary_tool');
    case 'foreground_child_tool_cancel': return cancellationPolicy('foreground_child_tool');
    case 'answer_bridge_child_interrupt': return cancellationPolicy('explicit_child_interrupt');
    case 'conversation_stop': return cancellationPolicy('conversation_stop');
    case 'run_tree_stop': return cancellationPolicy('full_tree_stop');
    case 'run_replacement': return cancellationPolicy('run_replacement');
  }
}

export function cancellationPolicyNameForIntent(intent: CancellationIntent): CancellationPolicyName {
  return cancellationPolicyForIntent(intent).name;
}
