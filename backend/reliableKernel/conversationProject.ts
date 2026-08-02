import { createHash } from 'node:crypto';
import {
  DOMAIN_REPOSITORIES,
  savepoint,
  type RepositoryTransactionStep
} from './repositories';

const PROJECT_CONTEXT_ID_DOMAIN = 'limcode-reliable-project-context\0';
const CONVERSATION_PROJECT_LINK_ID_DOMAIN = 'limcode-reliable-conversation-project-link\0';

export interface ProjectFolderAssignment {
  uri: string;
  name: string;
}

/** Stable identity for one canonical workspace-folder URI. */
export function projectContextIdForUri(uriInput: string): string {
  const uri = requireText(uriInput, 'ProjectContext.uri');
  return `project_context_${digest(PROJECT_CONTEXT_ID_DOMAIN, uri)}`;
}

/** Stable one-primary-project relationship identity for a Conversation. */
export function conversationProjectLinkId(conversationIdInput: string): string {
  const conversationId = requireText(conversationIdInput, 'ConversationProjectLink.conversation_id');
  return `conversation_project_link_${digest(CONVERSATION_PROJECT_LINK_ID_DOMAIN, conversationId)}`;
}

/**
 * Prepare a canonical ProjectContext plus its independent Conversation relationship.
 *
 * The savepoint makes concurrent Extension Hosts converge on the same URI identity. The following
 * assert rejects a cryptographic-id collision or a conflicting canonical row instead of silently
 * binding the Conversation to unrelated project data.
 */
export function projectFolderAssignmentSteps(input: {
  conversationId: string;
  folder: ProjectFolderAssignment;
  now: string;
}): RepositoryTransactionStep[] {
  const conversationId = requireText(input.conversationId, 'conversationId');
  const uri = requireText(input.folder.uri, 'folder.uri');
  const name = requireText(input.folder.name, 'folder.name');
  const now = requireText(input.now, 'now');
  const projectContextId = projectContextIdForUri(uri);
  return [
    savepoint('project_context_identity', [
      DOMAIN_REPOSITORIES.domain('ProjectContext').insert({
        id: projectContextId,
        kind: 'folder',
        uri,
        name,
        created_at: now,
        updated_at: now
      })
    ], {
      kind: 'rollback-and-continue-on-unique',
      constraints: [
        { domain: 'ProjectContext', columns: ['id'] },
        { domain: 'ProjectContext', columns: ['uri'] }
      ]
    }),
    DOMAIN_REPOSITORIES.domain('ProjectContext').assert(projectContextId, {
      kind: 'folder',
      uri
    }),
    DOMAIN_REPOSITORIES.domain('ProjectContext').update(projectContextId, {
      name,
      updated_at: now
    }),
    conversationProjectLinkInsertStep({ conversationId, projectContextId, now })
  ];
}

export function conversationProjectLinkInsertStep(input: {
  conversationId: string;
  projectContextId: string;
  now: string;
}): RepositoryTransactionStep {
  const conversationId = requireText(input.conversationId, 'conversationId');
  const projectContextId = requireText(input.projectContextId, 'projectContextId');
  const now = requireText(input.now, 'now');
  return DOMAIN_REPOSITORIES.domain('ConversationProjectLink').insert({
    id: conversationProjectLinkId(conversationId),
    conversation_id: conversationId,
    project_context_id: projectContextId,
    role: 'primary',
    created_at: now,
    updated_at: now
  });
}

function digest(domain: string, value: string): string {
  return createHash('sha256').update(domain).update(value).digest('hex');
}

function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be non-empty text.`);
  }
  return value.trim();
}
