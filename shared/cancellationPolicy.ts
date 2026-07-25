/** Product-level cancellation semantics shared by reliable and legacy adapters. */
export type CancellationPolicyName =
  | 'ordinary_tool'
  | 'foreground_child_tool'
  | 'explicit_child_interrupt'
  | 'conversation_stop'
  | 'full_tree_stop'
  | 'run_replacement';

export interface CancellationPolicy {
  name: CancellationPolicyName;
  descendants: 'none' | 'foreground' | 'foreground_and_background';
  includeDetached: false;
  traverseTerminalIntermediates: true;
  parentDisposition: 'continue_with_interrupted_tool' | 'terminate' | 'replace';
  bridgeDisposition: 'preserve' | 'cancel_included' | 'detach_background';
  runtimeDisposition: 'abort_active_effects';
}

const POLICIES: Readonly<Record<CancellationPolicyName, CancellationPolicy>> = {
  ordinary_tool: {
    name: 'ordinary_tool', descendants: 'none', includeDetached: false, traverseTerminalIntermediates: true,
    parentDisposition: 'continue_with_interrupted_tool', bridgeDisposition: 'preserve', runtimeDisposition: 'abort_active_effects'
  },
  foreground_child_tool: {
    name: 'foreground_child_tool', descendants: 'foreground_and_background', includeDetached: false, traverseTerminalIntermediates: true,
    parentDisposition: 'continue_with_interrupted_tool', bridgeDisposition: 'cancel_included', runtimeDisposition: 'abort_active_effects'
  },
  explicit_child_interrupt: {
    name: 'explicit_child_interrupt', descendants: 'foreground_and_background', includeDetached: false, traverseTerminalIntermediates: true,
    parentDisposition: 'continue_with_interrupted_tool', bridgeDisposition: 'cancel_included', runtimeDisposition: 'abort_active_effects'
  },
  conversation_stop: {
    name: 'conversation_stop', descendants: 'foreground', includeDetached: false, traverseTerminalIntermediates: true,
    parentDisposition: 'terminate', bridgeDisposition: 'detach_background', runtimeDisposition: 'abort_active_effects'
  },
  full_tree_stop: {
    name: 'full_tree_stop', descendants: 'foreground_and_background', includeDetached: false, traverseTerminalIntermediates: true,
    parentDisposition: 'terminate', bridgeDisposition: 'cancel_included', runtimeDisposition: 'abort_active_effects'
  },
  run_replacement: {
    name: 'run_replacement', descendants: 'foreground', includeDetached: false, traverseTerminalIntermediates: true,
    parentDisposition: 'replace', bridgeDisposition: 'detach_background', runtimeDisposition: 'abort_active_effects'
  }
};

export function cancellationPolicy(name: CancellationPolicyName): CancellationPolicy {
  return POLICIES[name];
}

export function runGraphCascadeForPolicy(name: CancellationPolicyName): {
  cascadeForegroundChildren: boolean;
  cascadeBackgroundChildren: boolean;
} {
  const policy = cancellationPolicy(name);
  return {
    cascadeForegroundChildren: policy.descendants === 'foreground' || policy.descendants === 'foreground_and_background',
    cascadeBackgroundChildren: policy.descendants === 'foreground_and_background'
  };
}
