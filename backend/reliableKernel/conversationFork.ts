import { createHash } from 'node:crypto';
import {
  DOMAIN_REPOSITORIES,
  type DomainRow,
  type RepositoryTransactionStep
} from './repositories';
import { conversationProjectLinkInsertStep } from './conversationProject';
import { RuntimeDatabase } from './runtimeDatabase';

export interface ConversationForkCommand {
  /** Stable user/command identity. Replays with a different shape are rejected. */
  idempotencyKey: string;
  reuseKey: string;
  sourceConversationId: string;
  sourceContextRootId: string;
  sourceMessageRevisionId?: string;
  /** Optional UI CAS: the selected Message must still point at this exact revision at commit. */
  expectedCurrentMessageRevisionId?: string;
  sourceTurnId?: string;
  sourceToolCallId?: string;
  expectedSourceHeadRootId?: string;
  targetConversationId?: string;
  targetTitle: string;
  targetAgentId: string;
}

export interface ConversationForkResult {
  targetConversationId: string;
  targetRootId: string;
  targetHeadLinkId: string;
  reuseLinkId: string;
  branchLinkId: string;
  originLinkId: string;
  sharedRootNodeId: string | null;
  deduplicated: boolean;
  commitSeq?: string;
}

interface ForkIds {
  targetConversationId: string;
  targetRootId: string;
  targetHeadLinkId: string;
  targetAgentLinkId: string;
  reuseLinkId: string;
  branchLinkId: string;
  originLinkId: string;
}

/**
 * Phase F Conversation fork writer. It creates the target, its Context head, fork relation domains
 * and optional ProjectContext relationship in one SQLite transaction. Context nodes are immutable
 * and therefore referenced, never copied into the target Conversation.
 */
export class ConversationForkControlPlane {
  private readonly now: () => string;

  public constructor(
    private readonly database: RuntimeDatabase,
    options: { now?: () => string } = {}
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  public async fork(commandInput: ConversationForkCommand): Promise<ConversationForkResult> {
    let command: ResolvedForkCommand = normalizeForkCommand(commandInput);
    const ids = forkIds(command);
    const replay = await this.findReplay(command, ids);
    if (replay) return replay;

    const sourceProjectSnapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ConversationProjectLink').list({
        where: { conversation_id: command.sourceConversationId },
        limit: 2
      })
    ]);
    const sourceProjectLinks = requireRows(
      sourceProjectSnapshot.snapshot[0],
      'ConversationProjectLink fork source lookup'
    );
    if (sourceProjectLinks.length > 1) {
      throw new Error('Fork source Conversation has multiple ProjectContext relationships.');
    }
    const sourceProjectLink = sourceProjectLinks[0] ?? null;
    if (sourceProjectLink && sourceProjectLink.role !== 'primary') {
      throw new Error('Fork source Conversation has a non-primary ProjectContext relationship.');
    }
    command = {
      ...command,
      ...(sourceProjectLink
        ? { sourceProjectContextId: requireId(
            sourceProjectLink.project_context_id,
            'ConversationProjectLink.project_context_id'
          ) }
        : {})
    };

    const sourceSnapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('Conversation').get(command.sourceConversationId),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(command.sourceContextRootId),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').list({
        where: { conversation_id: command.sourceConversationId },
        limit: 2
      }),
      ...(command.sourceMessageRevisionId
        ? [DOMAIN_REPOSITORIES.domain('MessageRevision').get(command.sourceMessageRevisionId)]
        : []),
      ...(command.sourceTurnId
        ? [DOMAIN_REPOSITORIES.domain('Turn').get(command.sourceTurnId)]
        : []),
      ...(command.sourceToolCallId
        ? [DOMAIN_REPOSITORIES.domain('ToolCall').get(command.sourceToolCallId)]
        : []),
      ...(command.sourceProjectContextId
        ? [DOMAIN_REPOSITORIES.domain('ProjectContext').get(command.sourceProjectContextId)]
        : [])
    ]);
    let cursor = 0;
    const sourceConversation = requireRow(sourceSnapshot.snapshot[cursor++], `Conversation ${command.sourceConversationId}`);
    const sourceRoot = requireRow(sourceSnapshot.snapshot[cursor++], `ContextSequenceRoot ${command.sourceContextRootId}`);
    const sourceHeads = requireRows(sourceSnapshot.snapshot[cursor++], 'ConversationContextHeadLink source lookup');
    if (sourceRoot.conversation_id !== sourceConversation.id) {
      throw new Error('Fork source ContextSequenceRoot does not belong to the source Conversation.');
    }
    if (sourceHeads.length !== 1) {
      throw new Error(`Source Conversation ${command.sourceConversationId} must have exactly one Context head.`);
    }
    const sourceHead = sourceHeads[0];
    if (
      command.expectedSourceHeadRootId !== undefined
      && sourceHead.root_id !== command.expectedSourceHeadRootId
    ) {
      throw new Error('Fork source expected head is stale.');
    }

    const sourceRevision = command.sourceMessageRevisionId
      ? requireRow(sourceSnapshot.snapshot[cursor++], `MessageRevision ${command.sourceMessageRevisionId}`)
      : null;
    const sourceTurn = command.sourceTurnId
      ? requireRow(sourceSnapshot.snapshot[cursor++], `Turn ${command.sourceTurnId}`)
      : null;
    const sourceToolCall = command.sourceToolCallId
      ? requireRow(sourceSnapshot.snapshot[cursor++], `ToolCall ${command.sourceToolCallId}`)
      : null;
    const sourceProjectContext = command.sourceProjectContextId
      ? requireRow(sourceSnapshot.snapshot[cursor++], `ProjectContext ${command.sourceProjectContextId}`)
      : null;
    if (sourceTurn && sourceTurn.conversation_id !== command.sourceConversationId) {
      throw new Error('Fork source Turn does not belong to the source Conversation.');
    }
    if (sourceToolCall && command.sourceTurnId && sourceToolCall.turn_id !== command.sourceTurnId) {
      throw new Error('Fork source ToolCall does not belong to the selected source Turn.');
    }

    let currentRevisionLink: DomainRow | null = null;
    if (command.expectedCurrentMessageRevisionId) {
      if (!sourceRevision || command.expectedCurrentMessageRevisionId !== command.sourceMessageRevisionId) {
        throw new Error('Fork current-revision CAS requires the selected source MessageRevision.');
      }
      const currentSnapshot = await this.database.snapshot([
        DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').list({
          where: { message_id: requireId(sourceRevision.message_id, 'MessageRevision.message_id') },
          limit: 2
        })
      ]);
      const currentRows = requireRows(currentSnapshot.snapshot[0], 'MessageCurrentRevisionLink fork source lookup');
      if (
        currentRows.length !== 1
        || currentRows[0].revision_id !== command.expectedCurrentMessageRevisionId
      ) throw new Error('Fork source Message current Revision is stale.');
      currentRevisionLink = currentRows[0];
    }

    let sourceMembership: DomainRow | null = null;
    if (sourceRevision) {
      const memberships = await this.database.snapshot([
        DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').list({
          where: {
            conversation_id: command.sourceConversationId,
            message_id: requireId(sourceRevision.message_id, 'MessageRevision.message_id')
          },
          limit: 2
        })
      ]);
      const rows = requireRows(memberships.snapshot[0], 'MessagePartOfConversation source lookup');
      if (rows.length !== 1) {
        throw new Error('Fork source MessageRevision is not a historical member of the source Conversation.');
      }
      sourceMembership = rows[0];
    }

    const now = this.timestamp();
    const sharedRootNodeId = nullableId(sourceRoot.root_node_id, 'ContextSequenceRoot.root_node_id');
    const steps: RepositoryTransactionStep[] = [
      DOMAIN_REPOSITORIES.domain('Conversation').assert(command.sourceConversationId, {
        status: sourceConversation.status
      }),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').assert(command.sourceContextRootId, {
        conversation_id: command.sourceConversationId,
        root_node_id: sharedRootNodeId,
        tail_node_id: sourceRoot.tail_node_id,
        tail_segment_count: sourceRoot.tail_segment_count,
        segment_count: sourceRoot.segment_count
      }),
      ...(command.expectedSourceHeadRootId !== undefined
        ? [DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').assert(
            requireId(sourceHead.id, 'ConversationContextHeadLink.id'),
            { conversation_id: command.sourceConversationId, root_id: command.expectedSourceHeadRootId }
          )]
        : []),
      ...(sourceRevision
        ? [DOMAIN_REPOSITORIES.domain('MessageRevision').assert(command.sourceMessageRevisionId!, {
            message_id: sourceRevision.message_id,
            revision_seq: sourceRevision.revision_seq
          })]
        : []),
      ...(currentRevisionLink
        ? [DOMAIN_REPOSITORIES.domain('MessageCurrentRevisionLink').assert(
            requireId(currentRevisionLink.id, 'MessageCurrentRevisionLink.id'),
            {
              message_id: sourceRevision!.message_id,
              revision_id: command.expectedCurrentMessageRevisionId
            }
          )]
        : []),
      ...(sourceMembership
        ? [DOMAIN_REPOSITORIES.domain('MessagePartOfConversation').assert(
            requireId(sourceMembership.id, 'MessagePartOfConversation.id'),
            { conversation_id: command.sourceConversationId, message_id: sourceMembership.message_id }
          )]
        : []),
      ...(sourceTurn
        ? [DOMAIN_REPOSITORIES.domain('Turn').assert(command.sourceTurnId!, {
            conversation_id: command.sourceConversationId
          })]
        : []),
      ...(sourceToolCall
        ? [DOMAIN_REPOSITORIES.domain('ToolCall').assert(command.sourceToolCallId!, {
            turn_id: sourceToolCall.turn_id
          })]
        : []),
      ...(sourceProjectLink && sourceProjectContext
        ? [
            DOMAIN_REPOSITORIES.domain('ConversationProjectLink').assert(
              requireId(sourceProjectLink.id, 'ConversationProjectLink.id'),
              {
                conversation_id: command.sourceConversationId,
                project_context_id: command.sourceProjectContextId,
                role: 'primary'
              }
            ),
            DOMAIN_REPOSITORIES.domain('ProjectContext').assert(command.sourceProjectContextId!, {
              kind: sourceProjectContext.kind,
              uri: sourceProjectContext.uri
            })
          ]
        : [DOMAIN_REPOSITORIES.domain('ConversationProjectLink').assertNone({
            conversation_id: command.sourceConversationId
          })]),
      DOMAIN_REPOSITORIES.domain('Conversation').insert({
        id: ids.targetConversationId,
        title: command.targetTitle,
        status: 'active',
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').insertWithNextSequence({
        id: ids.targetRootId,
        conversation_id: ids.targetConversationId,
        root_node_id: sharedRootNodeId,
        tail_node_id: sourceRoot.tail_node_id,
        tail_segment_count: sourceRoot.tail_segment_count,
        segment_count: sourceRoot.segment_count,
        estimated_tokens: sourceRoot.estimated_tokens,
        created_at: now
      }, {
        column: 'root_seq',
        scope: { conversation_id: ids.targetConversationId }
      }),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').insert({
        id: ids.targetHeadLinkId,
        conversation_id: ids.targetConversationId,
        root_id: ids.targetRootId,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').insert({
        id: ids.targetAgentLinkId,
        conversation_id: ids.targetConversationId,
        agent_id: command.targetAgentId,
        role: 'default',
        created_at: now,
        updated_at: now
      }),
      ...(command.sourceProjectContextId
        ? [conversationProjectLinkInsertStep({
            conversationId: ids.targetConversationId,
            projectContextId: command.sourceProjectContextId,
            now
          })]
        : []),
      DOMAIN_REPOSITORIES.domain('ConversationReuseLink').insert({
        id: ids.reuseLinkId,
        reuse_key: command.reuseKey,
        conversation_id: ids.targetConversationId,
        agent_id: command.targetAgentId,
        created_at: now,
        updated_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ConversationBranchLink').insert({
        id: ids.branchLinkId,
        target_conversation_id: ids.targetConversationId,
        source_conversation_id: command.sourceConversationId,
        source_message_revision_id: command.sourceMessageRevisionId ?? null,
        created_at: now
      }),
      DOMAIN_REPOSITORIES.domain('ConversationOriginLink').insert({
        id: ids.originLinkId,
        conversation_id: ids.targetConversationId,
        source_conversation_id: command.sourceConversationId,
        source_turn_id: command.sourceTurnId ?? null,
        source_tool_call_id: command.sourceToolCallId ?? null,
        source_message_revision_id: command.sourceMessageRevisionId ?? null,
        created_at: now
      })
    ];

    try {
      const commit = await this.database.transaction(steps);
      return {
        ...publicIds(ids),
        sharedRootNodeId,
        deduplicated: false,
        commitSeq: commit.commitSeq
      };
    } catch (error) {
      if (!isExpectedForkIdentityConflict(error)) throw error;
      const raced = await this.findReplay(command, ids);
      if (!raced) throw error;
      return raced;
    }
  }

  private async findReplay(
    command: ResolvedForkCommand,
    ids: ForkIds
  ): Promise<ConversationForkResult | null> {
    const snapshot = await this.database.snapshot([
      DOMAIN_REPOSITORIES.domain('ConversationReuseLink').list({
        where: { reuse_key: command.reuseKey },
        limit: 2
      }),
      DOMAIN_REPOSITORIES.domain('Conversation').get(ids.targetConversationId),
      DOMAIN_REPOSITORIES.domain('ContextSequenceRoot').get(ids.targetRootId),
      DOMAIN_REPOSITORIES.domain('ConversationContextHeadLink').get(ids.targetHeadLinkId),
      DOMAIN_REPOSITORIES.domain('AgentConversationLink').get(ids.targetAgentLinkId),
      DOMAIN_REPOSITORIES.domain('ConversationBranchLink').get(ids.branchLinkId),
      DOMAIN_REPOSITORIES.domain('ConversationOriginLink').get(ids.originLinkId),
      DOMAIN_REPOSITORIES.domain('ConversationProjectLink').list({
        where: { conversation_id: ids.targetConversationId },
        limit: 2
      })
    ]);
    const reuseRows = requireRows(snapshot.snapshot[0], 'ConversationReuseLink replay lookup');
    if (reuseRows.length === 0) return null;
    if (reuseRows.length !== 1) throw new Error(`Conversation reuse key ${command.reuseKey} is not unique.`);
    const reuse = reuseRows[0];
    const conversation = requireRow(snapshot.snapshot[1], `Conversation ${ids.targetConversationId}`);
    const root = requireRow(snapshot.snapshot[2], `ContextSequenceRoot ${ids.targetRootId}`);
    const head = requireRow(snapshot.snapshot[3], `ConversationContextHeadLink ${ids.targetHeadLinkId}`);
    const agentLink = requireRow(snapshot.snapshot[4], `AgentConversationLink ${ids.targetAgentLinkId}`);
    const branch = requireRow(snapshot.snapshot[5], `ConversationBranchLink ${ids.branchLinkId}`);
    const origin = requireRow(snapshot.snapshot[6], `ConversationOriginLink ${ids.originLinkId}`);
    const targetProjectLinks = requireRows(snapshot.snapshot[7], 'ConversationProjectLink replay lookup');
    if (targetProjectLinks.length > 1) {
      throw new Error(`Fork target Conversation ${ids.targetConversationId} has multiple project links.`);
    }
    if (targetProjectLinks[0] && targetProjectLinks[0].role !== 'primary') {
      throw new Error(`Fork target Conversation ${ids.targetConversationId} has a non-primary project link.`);
    }
    if (
      reuse.id !== ids.reuseLinkId
      || reuse.conversation_id !== ids.targetConversationId
      || reuse.agent_id !== command.targetAgentId
      || conversation.id !== ids.targetConversationId
      || conversation.title !== command.targetTitle
      || root.conversation_id !== ids.targetConversationId
      || head.conversation_id !== ids.targetConversationId
      || head.root_id !== ids.targetRootId
      || agentLink.conversation_id !== ids.targetConversationId
      || agentLink.agent_id !== command.targetAgentId
      || agentLink.role !== 'default'
      || branch.target_conversation_id !== ids.targetConversationId
      || branch.source_conversation_id !== command.sourceConversationId
      || branch.source_message_revision_id !== (command.sourceMessageRevisionId ?? null)
      || origin.conversation_id !== ids.targetConversationId
      || origin.source_conversation_id !== command.sourceConversationId
      || origin.source_turn_id !== (command.sourceTurnId ?? null)
      || origin.source_tool_call_id !== (command.sourceToolCallId ?? null)
      || origin.source_message_revision_id !== (command.sourceMessageRevisionId ?? null)
    ) {
      throw new Error(`Conversation fork identity ${command.reuseKey} was replayed with different facts.`);
    }
    return {
      ...publicIds(ids),
      sharedRootNodeId: nullableId(root.root_node_id, 'ContextSequenceRoot.root_node_id'),
      deduplicated: true
    };
  }

  private timestamp(): string {
    const value = this.now();
    if (typeof value !== 'string' || value.length === 0) throw new TypeError('Conversation fork clock returned an invalid timestamp.');
    return value;
  }
}

function normalizeForkCommand(command: ConversationForkCommand) {
  const idempotencyKey = requireText(command.idempotencyKey, 'idempotencyKey');
  const reuseKey = requireText(command.reuseKey, 'reuseKey');
  const sourceConversationId = requireId(command.sourceConversationId, 'sourceConversationId');
  const sourceContextRootId = requireId(command.sourceContextRootId, 'sourceContextRootId');
  const sourceMessageRevisionId = optionalId(command.sourceMessageRevisionId, 'sourceMessageRevisionId');
  const expectedCurrentMessageRevisionId = optionalId(
    command.expectedCurrentMessageRevisionId,
    'expectedCurrentMessageRevisionId'
  );
  const sourceTurnId = optionalId(command.sourceTurnId, 'sourceTurnId');
  const sourceToolCallId = optionalId(command.sourceToolCallId, 'sourceToolCallId');
  const expectedSourceHeadRootId = optionalId(command.expectedSourceHeadRootId, 'expectedSourceHeadRootId');
  const targetConversationId = optionalId(command.targetConversationId, 'targetConversationId');
  const targetTitle = requireText(command.targetTitle, 'targetTitle');
  const targetAgentId = requireId(command.targetAgentId, 'targetAgentId');
  if (sourceToolCallId && !sourceTurnId) {
    throw new TypeError('sourceToolCallId requires sourceTurnId.');
  }
  if (expectedCurrentMessageRevisionId && expectedCurrentMessageRevisionId !== sourceMessageRevisionId) {
    throw new TypeError('expectedCurrentMessageRevisionId must equal sourceMessageRevisionId.');
  }
  return {
    idempotencyKey,
    reuseKey,
    sourceConversationId,
    sourceContextRootId,
    ...(sourceMessageRevisionId ? { sourceMessageRevisionId } : {}),
    ...(expectedCurrentMessageRevisionId ? { expectedCurrentMessageRevisionId } : {}),
    ...(sourceTurnId ? { sourceTurnId } : {}),
    ...(sourceToolCallId ? { sourceToolCallId } : {}),
    ...(expectedSourceHeadRootId ? { expectedSourceHeadRootId } : {}),
    ...(targetConversationId ? { targetConversationId } : {}),
    targetTitle,
    targetAgentId
  };
}

type ResolvedForkCommand = ReturnType<typeof normalizeForkCommand> & {
  sourceProjectContextId?: string;
};

function forkIds(command: ResolvedForkCommand): ForkIds {
  const scope = JSON.stringify([
    command.idempotencyKey,
    command.reuseKey,
    command.sourceConversationId,
    command.sourceContextRootId,
    command.sourceMessageRevisionId ?? null,
    command.sourceTurnId ?? null,
    command.sourceToolCallId ?? null,
    command.expectedSourceHeadRootId ?? null,
    command.targetConversationId ?? null,
    command.targetTitle,
    command.targetAgentId
  ]);
  const targetConversationId = command.targetConversationId ?? stableId('conversation', scope);
  return {
    targetConversationId,
    targetRootId: stableId('context_root', scope),
    targetHeadLinkId: stableId('context_head_link', scope),
    targetAgentLinkId: stableId('agent_conversation_link', scope),
    reuseLinkId: stableId('conversation_reuse_link', scope),
    branchLinkId: stableId('conversation_branch_link', scope),
    originLinkId: stableId('conversation_origin_link', scope)
  };
}

function publicIds(ids: ForkIds): Omit<ConversationForkResult, 'sharedRootNodeId' | 'deduplicated' | 'commitSeq'> {
  return {
    targetConversationId: ids.targetConversationId,
    targetRootId: ids.targetRootId,
    targetHeadLinkId: ids.targetHeadLinkId,
    reuseLinkId: ids.reuseLinkId,
    branchLinkId: ids.branchLinkId,
    originLinkId: ids.originLinkId
  };
}

function stableId(kind: string, scope: string): string {
  const digest = createHash('sha256')
    .update('limcode-phase-f-conversation-fork\0')
    .update(kind)
    .update('\0')
    .update(scope)
    .digest('hex');
  return `${kind}_${digest}`;
}

function isExpectedForkIdentityConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('UNIQUE constraint failed: conversation_reuse_link.reuse_key')
    || message.includes('UNIQUE constraint failed: conversation_reuse_link.id')
    || message.includes('UNIQUE constraint failed: conversation.id')
    || message.includes('UNIQUE constraint failed: conversation_branch_link.target_conversation_id')
    || message.includes('UNIQUE constraint failed: conversation_origin_link.conversation_id')
    || message.includes('UNIQUE constraint failed: conversation_project_link.conversation_id')
    || message.includes('UNIQUE constraint failed: conversation_project_link.id');
}

function requireRow(value: unknown, label: string): DomainRow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} does not exist.`);
  return value as DomainRow;
}

function requireRows(value: unknown, label: string): DomainRow[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} did not return rows.`);
  return value as DomainRow[];
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty id.`);
  return value.trim();
}

function optionalId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireId(value, label);
}

function nullableId(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requireId(value, label);
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be non-empty text.`);
  return value.trim();
}
