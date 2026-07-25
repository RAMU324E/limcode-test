import type { ChildTurnLinkRecord, RunGraphClosureMode } from '../../shared/conversationReliability';
import type { ConversationId, RunId } from '../../shared/stableIds';
import type { DurableConversationFacts } from './domain/types';

export interface AnswerBridgeLookupEntryLike {
  bridgeId: string;
  sourceConversationId: ConversationId;
  targetConversationId: ConversationId;
  ownerRunId: RunId;
  ownerGeneration: number;
  lifecycle: 'open' | 'closed' | 'cancelled';
  rowVersion: number;
}

export interface RunGraphReadAccess {
  loadFacts(conversationId: ConversationId): Promise<DurableConversationFacts>;
  readAnswerBridgeLookup(): Promise<{ bridges: AnswerBridgeLookupEntryLike[] }>;
}

export interface RunGraphNodeRef {
  conversationId: ConversationId;
  runId: RunId;
  terminal: boolean;
}

export interface ResolvedRunGraphEdge {
  parent: RunGraphNodeRef;
  child: RunGraphNodeRef;
  mode: RunGraphClosureMode;
  relationId: string;
  answerBridgeId?: string;
  sourceToolCallId?: string;
}

export interface ResolvedRunGraphClosure {
  roots: RunGraphNodeRef[];
  nodes: RunGraphNodeRef[];
  edges: ResolvedRunGraphEdge[];
  conversationIds: ConversationId[];
  activeRunIds: RunId[];
  alreadyTerminalRunIds: RunId[];
  modes: RunGraphClosureMode[];
}

export class RunGraphClosureIntegrityError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'RunGraphClosureIntegrityError';
  }
}

/** Resolves a complete cross-Conversation graph before mutation. Detached edges are never followed. */
export async function resolveRunGraphClosure(
  roots: readonly { conversationId: ConversationId; runId: RunId }[],
  options: { modes: readonly RunGraphClosureMode[] },
  readAccess: RunGraphReadAccess
): Promise<ResolvedRunGraphClosure> {
  if (roots.length === 0) throw new RunGraphClosureIntegrityError('RunGraph closure requires at least one root.');
  const modes = [...new Set(options.modes)].sort();
  if (modes.length === 0) throw new RunGraphClosureIntegrityError('RunGraph closure requires at least one edge mode.');
  const includedModes = new Set<RunGraphClosureMode>(modes);
  const lookup = await readAccess.readAnswerBridgeLookup();
  const bridgeById = new Map<string, AnswerBridgeLookupEntryLike>();
  for (const bridge of lookup.bridges) {
    if (bridgeById.has(bridge.bridgeId)) throw new RunGraphClosureIntegrityError(`AnswerBridge lookup contains duplicate ownership: ${bridge.bridgeId}`);
    bridgeById.set(bridge.bridgeId, bridge);
  }

  const factsByConversation = new Map<ConversationId, DurableConversationFacts>();
  const load = async (conversationId: ConversationId): Promise<DurableConversationFacts> => {
    const existing = factsByConversation.get(conversationId);
    if (existing) return existing;
    const facts = await readAccess.loadFacts(conversationId);
    factsByConversation.set(conversationId, facts);
    return facts;
  };
  const nodeByKey = new Map<string, RunGraphNodeRef>();
  const edges: ResolvedRunGraphEdge[] = [];
  const queue = [...new Map(roots.map((root) => [`${root.conversationId}:${root.runId}`, root] as const)).values()];

  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentKey = `${current.conversationId}:${current.runId}`;
    if (nodeByKey.has(currentKey)) continue;
    const facts = await load(current.conversationId);
    const run = uniqueRun(facts, current.runId, current.conversationId);
    const parentNode: RunGraphNodeRef = {
      conversationId: current.conversationId,
      runId: current.runId,
      terminal: run.phase === 'terminal'
    };
    nodeByKey.set(currentKey, parentNode);

    for (const relation of facts.childTurnLinks.filter((candidate) => candidate.parentTurnId === current.runId)) {
      if (relation.mode === 'detached' || !includedModes.has(relation.mode)) continue;
      const childLocation = await resolveChildLocation(current, relation, bridgeById, load);
      const childFacts = await load(childLocation.conversationId);
      const childRun = uniqueRun(childFacts, relation.childTurnId, childLocation.conversationId);
      const childNode: RunGraphNodeRef = {
        conversationId: childLocation.conversationId,
        runId: relation.childTurnId,
        terminal: childRun.phase === 'terminal'
      };
      edges.push({
        parent: parentNode,
        child: childNode,
        mode: relation.mode,
        relationId: relation.id,
        answerBridgeId: relation.answerBridgeId,
        ...(relation.sourceToolCallId ? { sourceToolCallId: relation.sourceToolCallId } : {})
      });
      queue.push({ conversationId: childLocation.conversationId, runId: relation.childTurnId });
    }
  }

  const nodes = [...nodeByKey.values()].sort(compareNode);
  const resolvedRoots = roots.map((root) => {
    const node = nodeByKey.get(`${root.conversationId}:${root.runId}`);
    if (!node) throw new RunGraphClosureIntegrityError(`Resolved closure lost root ${root.conversationId}:${root.runId}.`);
    return node;
  });
  return {
    roots: resolvedRoots,
    nodes,
    edges: edges.sort((left, right) => compareNode(left.parent, right.parent) || compareNode(left.child, right.child) || left.relationId.localeCompare(right.relationId)),
    conversationIds: [...factsByConversation.keys()].sort(),
    activeRunIds: nodes.filter((node) => !node.terminal).map((node) => node.runId),
    alreadyTerminalRunIds: nodes.filter((node) => node.terminal).map((node) => node.runId),
    modes
  };
}

async function resolveChildLocation(
  parent: { conversationId: ConversationId; runId: RunId },
  relation: ChildTurnLinkRecord,
  bridgeById: ReadonlyMap<string, AnswerBridgeLookupEntryLike>,
  load: (conversationId: ConversationId) => Promise<DurableConversationFacts>
): Promise<{ conversationId: ConversationId }> {
  if (relation.parentConversationId !== parent.conversationId || relation.parentTurnId !== parent.runId) {
    throw new RunGraphClosureIntegrityError(`${relation.mode} child relation ${relation.id} has mismatched parent ownership.`);
  }
  const bridge = bridgeById.get(relation.answerBridgeId);
  if (!bridge
    || bridge.sourceConversationId !== parent.conversationId
    || bridge.targetConversationId !== relation.childConversationId
    || bridge.ownerRunId !== parent.runId) {
    throw new RunGraphClosureIntegrityError(`${relation.mode} child relation ${relation.id} is absent from the AnswerBridge lookup.`);
  }
  const targetFacts = await load(relation.childConversationId);
  const sources = targetFacts.runSources.filter((source) => source.runId === relation.childTurnId);
  if (sources.length !== 1
    || sources[0].answerBridgeId !== relation.answerBridgeId
    || sources[0].sourceConversationId !== parent.conversationId
    || sources[0].sourceRunId !== parent.runId) {
    throw new RunGraphClosureIntegrityError(`${relation.mode} child Turn ${relation.childTurnId} is not owned by ${relation.childConversationId}.`);
  }
  return { conversationId: relation.childConversationId };
}

function uniqueRun(facts: DurableConversationFacts, runId: RunId, conversationId: ConversationId) {
  const runs = facts.turns.filter((run) => run.id === runId);
  if (runs.length !== 1 || runs[0].conversationId !== conversationId) {
    throw new RunGraphClosureIntegrityError(`Run ${runId} has ${runs.length} owners in ${conversationId}.`);
  }
  return runs[0];
}

function compareNode(left: RunGraphNodeRef, right: RunGraphNodeRef): number {
  return left.conversationId.localeCompare(right.conversationId) || left.runId.localeCompare(right.runId);
}
