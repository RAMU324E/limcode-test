import * as vscode from 'vscode';
import type {
  AgentConversationLinkRecord,
  AgentAnswerRecord,
  AgentAnswerSubmissionLinkRecord,
  AgentAnswerTargetLinkRecord,
  AgentRecord,
  CheckpointPolicyRecord,
  CheckpointPolicyScopeLinkRecord,
  CheckpointRecord,
  CheckpointTimelineAnchorRecord,
  ClientState,
  ConversationCheckpointRepositoryLinkRecord,
  ConversationBranchLinkRecord,
  ConversationAgentSelectionRecord,
  ConversationWorkflowSelectionRecord,
  ConversationProjectLinkRecord,
  ConversationOriginLinkRecord,
  ConversationReuseLinkRecord,
  WorkflowRecord,
  PlanReviewPolicyRecord,
  PlanReviewPolicyScopeLinkRecord,
  ModelProfileRecord,
  ModelProfileScopeLinkRecord,
  ProjectContextRecord,
  SystemPromptRecord,
  SystemPromptScopeLinkRecord,
  RuntimeContextRecord,
  RuntimeContextScopeLinkRecord,
  RuntimeContextSnapshotRecord,
  ConversationRuntimeContextSnapshotLinkRecord,
  RunRuntimeContextSnapshotLinkRecord,
  ToolPolicyRecord,
  ToolPolicyScopeLinkRecord,
  SkillPolicyRecord,
  SkillPolicyScopeLinkRecord,
  WorkEnvironmentRecord,
  ShadowRepositoryRecord,
  ConversationWorkEnvironmentLinkRecord,
  RunWorkEnvironmentLinkRecord,
  WorkEnvironmentPolicyRecord,
  WorkEnvironmentPolicyScopeLinkRecord
} from '../../../shared/protocol';
import { createEmptyClientState } from '../../../shared/clientStateSchema';
import { INDEX_FILE } from './constants';
import { createVscodeStoragePaths } from './paths';
import { loadRecordStore, saveRecordStore } from './recordStore';

export type StoragePaths = ReturnType<typeof createVscodeStoragePaths>;

export interface LoadClientStateSkeletonOptions {
  profile?: 'startup' | 'deferred' | 'full';
}

type StoreKey = string;
type StoreRecord = { id: string };

const CONVERSATION_REUSE_LINKS_DIR = 'reuse-links';
const CONVERSATION_BRANCH_LINKS_DIR = 'branch-links';
const CONVERSATION_ORIGIN_LINKS_DIR = 'origin-links';

export async function loadClientStateSkeletonFromStores(paths: StoragePaths, options: LoadClientStateSkeletonOptions = {}): Promise<ClientState | undefined> {
  const state = createEmptyClientState();
  const profile = options.profile ?? 'full';

  if (profile === 'startup' || profile === 'full') {
    await loadStartupSkeletonRecords(paths, state);
  }

  if (profile === 'deferred' || profile === 'full') {
    await loadDeferredSkeletonRecords(paths, state);
  }

  return hasAnyState(state) ? state : undefined;
}

async function loadStartupSkeletonRecords(paths: StoragePaths, state: ClientState): Promise<void> {
  const [
    agents,
    workflows,
    planReviewPolicies,
    planReviewPolicyScopeLinks,
    toolPolicies,
    toolPolicyScopeLinks,
    skillPolicies,
    skillPolicyScopeLinks,
    systemPrompts,
    systemPromptScopeLinks,
    runtimeContexts,
    runtimeContextScopeLinks,
    runtimeContextSnapshots,
    conversationRuntimeContextSnapshotLinks,
    runRuntimeContextSnapshotLinks,
    modelProfiles,
    modelProfileScopeLinks,
    conversationWorkflowSelections,
    conversationReuseLinks,
    conversationBranchLinks,
    conversationOriginLinks,
    agentConversationLinks,
    conversationAgentSelections,
    agentAnswers,
    agentAnswerSubmissionLinks,
    agentAnswerTargetLinks
  ] = await Promise.all([
    loadSkeletonRecords<AgentRecord>('agents', [paths.agentsRootUri, paths.agentsIndexUri], 'agent'),
    loadSkeletonRecords<WorkflowRecord>('workflows', [paths.workflowsRootUri, paths.workflowsIndexUri], 'workflow'),
    loadSkeletonRecords<PlanReviewPolicyRecord>('planReviewPolicies', [paths.planReviewPoliciesRootUri, paths.planReviewPoliciesIndexUri], 'policy'),
    loadSkeletonRecords<PlanReviewPolicyScopeLinkRecord>('planReviewPolicyScopeLinks', [paths.planReviewPolicyScopeLinksRootUri, paths.planReviewPolicyScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<ToolPolicyRecord>('toolPolicies', [paths.toolPoliciesRootUri, paths.toolPoliciesIndexUri], 'toolPolicy'),
    loadSkeletonRecords<ToolPolicyScopeLinkRecord>('toolPolicyScopeLinks', [paths.toolPolicyScopeLinksRootUri, paths.toolPolicyScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<SkillPolicyRecord>('skillPolicies', [paths.skillPoliciesRootUri, paths.skillPoliciesIndexUri], 'skillPolicy'),
    loadSkeletonRecords<SkillPolicyScopeLinkRecord>('skillPolicyScopeLinks', [paths.skillPolicyScopeLinksRootUri, paths.skillPolicyScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<SystemPromptRecord>('systemPrompts', [paths.systemPromptsRootUri, paths.systemPromptsIndexUri], 'systemPrompt'),
    loadSkeletonRecords<SystemPromptScopeLinkRecord>('systemPromptScopeLinks', [paths.systemPromptScopeLinksRootUri, paths.systemPromptScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<RuntimeContextRecord>('runtimeContexts', [paths.runtimeContextsRootUri, paths.runtimeContextsIndexUri], 'runtimeContext'),
    loadSkeletonRecords<RuntimeContextScopeLinkRecord>('runtimeContextScopeLinks', [paths.runtimeContextScopeLinksRootUri, paths.runtimeContextScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<RuntimeContextSnapshotRecord>('runtimeContextSnapshots', [paths.runtimeContextSnapshotsRootUri, paths.runtimeContextSnapshotsIndexUri], 'snapshot'),
    loadSkeletonRecords<ConversationRuntimeContextSnapshotLinkRecord>('conversationRuntimeContextSnapshotLinks', [paths.conversationRuntimeContextSnapshotLinksRootUri, paths.conversationRuntimeContextSnapshotLinksIndexUri], 'link'),
    loadSkeletonRecords<RunRuntimeContextSnapshotLinkRecord>('runRuntimeContextSnapshotLinks', [paths.runRuntimeContextSnapshotLinksRootUri, paths.runRuntimeContextSnapshotLinksIndexUri], 'link'),
    loadSkeletonRecords<ModelProfileRecord>('modelProfiles', [paths.modelProfilesRootUri, paths.modelProfilesIndexUri], 'modelProfile'),
    loadSkeletonRecords<ModelProfileScopeLinkRecord>('modelProfileScopeLinks', [paths.modelProfileScopeLinksRootUri, paths.modelProfileScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<ConversationWorkflowSelectionRecord>('conversationWorkflowSelections', [paths.conversationWorkflowSelectionsRootUri, paths.conversationWorkflowSelectionsIndexUri], 'selection'),
    loadSkeletonRecords<ConversationReuseLinkRecord>('conversationReuseLinks', subStore(paths.conversationsRootUri, CONVERSATION_REUSE_LINKS_DIR), 'link'),
    loadSkeletonRecords<ConversationBranchLinkRecord>('conversationBranchLinks', subStore(paths.conversationsRootUri, CONVERSATION_BRANCH_LINKS_DIR), 'link'),
    loadSkeletonRecords<ConversationOriginLinkRecord>('conversationOriginLinks', subStore(paths.conversationsRootUri, CONVERSATION_ORIGIN_LINKS_DIR), 'link'),
    loadSkeletonRecords<AgentConversationLinkRecord>('agentConversationLinks', [paths.linksRootUri, paths.linksIndexUri], 'link'),
    loadSkeletonRecords<ConversationAgentSelectionRecord>('conversationAgentSelections', [paths.conversationAgentSelectionsRootUri, paths.conversationAgentSelectionsIndexUri], 'selection'),
    loadSkeletonRecords<AgentAnswerRecord>('agentAnswers', [paths.agentAnswersRootUri, paths.agentAnswersIndexUri], 'answer'),
    loadSkeletonRecords<AgentAnswerSubmissionLinkRecord>('agentAnswerSubmissionLinks', [paths.agentAnswerSubmissionLinksRootUri, paths.agentAnswerSubmissionLinksIndexUri], 'link'),
    loadSkeletonRecords<AgentAnswerTargetLinkRecord>('agentAnswerTargetLinks', [paths.agentAnswerTargetLinksRootUri, paths.agentAnswerTargetLinksIndexUri], 'link')
  ]);

  state.agents = agents;
  state.workflows = workflows;
  state.planReviewPolicies = planReviewPolicies;
  state.planReviewPolicyScopeLinks = planReviewPolicyScopeLinks;
  state.toolPolicies = toolPolicies;
  state.toolPolicyScopeLinks = toolPolicyScopeLinks;
  state.skillPolicies = skillPolicies;
  state.skillPolicyScopeLinks = skillPolicyScopeLinks;
  state.systemPrompts = systemPrompts;
  state.systemPromptScopeLinks = systemPromptScopeLinks;
  state.runtimeContexts = runtimeContexts;
  state.runtimeContextScopeLinks = runtimeContextScopeLinks;
  state.runtimeContextSnapshots = runtimeContextSnapshots;
  state.conversationRuntimeContextSnapshotLinks = conversationRuntimeContextSnapshotLinks;
  state.runRuntimeContextSnapshotLinks = runRuntimeContextSnapshotLinks;
  state.modelProfiles = modelProfiles;
  state.modelProfileScopeLinks = modelProfileScopeLinks;
  state.conversationWorkflowSelections = conversationWorkflowSelections;
  state.conversationReuseLinks = conversationReuseLinks;
  state.conversationBranchLinks = conversationBranchLinks;
  state.conversationOriginLinks = conversationOriginLinks;
  state.agentConversationLinks = agentConversationLinks;
  state.conversationAgentSelections = conversationAgentSelections;
  state.agentAnswers = agentAnswers;
  state.agentAnswerSubmissionLinks = agentAnswerSubmissionLinks;
  state.agentAnswerTargetLinks = agentAnswerTargetLinks;
}

async function loadDeferredSkeletonRecords(paths: StoragePaths, state: ClientState): Promise<void> {
  const [
    projectContexts,
    conversationProjectLinks,
    workEnvironments,
    conversationWorkEnvironmentLinks,
    runWorkEnvironmentLinks,
    workEnvironmentPolicies,
    workEnvironmentPolicyScopeLinks,
    checkpointPolicies,
    checkpointPolicyScopeLinks,
    shadowRepositories,
    conversationCheckpointRepositoryLinks,
    checkpoints,
    checkpointTimelineAnchors
  ] = await Promise.all([
    loadSkeletonRecords<ProjectContextRecord>('projectContexts', [paths.projectContextsRootUri, paths.projectContextsIndexUri], 'projectContext'),
    loadSkeletonRecords<ConversationProjectLinkRecord>('conversationProjectLinks', [paths.conversationProjectLinksRootUri, paths.conversationProjectLinksIndexUri], 'link'),
    loadSkeletonRecords<WorkEnvironmentRecord>('workEnvironments', [paths.workEnvironmentsRootUri, paths.workEnvironmentsIndexUri], 'workEnvironment'),
    loadSkeletonRecords<ConversationWorkEnvironmentLinkRecord>('conversationWorkEnvironmentLinks', [paths.conversationWorkEnvironmentLinksRootUri, paths.conversationWorkEnvironmentLinksIndexUri], 'link'),
    loadSkeletonRecords<RunWorkEnvironmentLinkRecord>('runWorkEnvironmentLinks', [paths.runWorkEnvironmentLinksRootUri, paths.runWorkEnvironmentLinksIndexUri], 'link'),
    loadSkeletonRecords<WorkEnvironmentPolicyRecord>('workEnvironmentPolicies', [paths.workEnvironmentPoliciesRootUri, paths.workEnvironmentPoliciesIndexUri], 'policy'),
    loadSkeletonRecords<WorkEnvironmentPolicyScopeLinkRecord>('workEnvironmentPolicyScopeLinks', [paths.workEnvironmentPolicyScopeLinksRootUri, paths.workEnvironmentPolicyScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<CheckpointPolicyRecord>('checkpointPolicies', [paths.checkpointPoliciesRootUri, paths.checkpointPoliciesIndexUri], 'policy'),
    loadSkeletonRecords<CheckpointPolicyScopeLinkRecord>('checkpointPolicyScopeLinks', [paths.checkpointPolicyScopeLinksRootUri, paths.checkpointPolicyScopeLinksIndexUri], 'link'),
    loadSkeletonRecords<ShadowRepositoryRecord>('shadowRepositories', [paths.shadowRepositoriesRootUri, paths.shadowRepositoriesIndexUri], 'shadowRepository'),
    loadSkeletonRecords<ConversationCheckpointRepositoryLinkRecord>('conversationCheckpointRepositoryLinks', [paths.conversationCheckpointRepositoryLinksRootUri, paths.conversationCheckpointRepositoryLinksIndexUri], 'link'),
    loadSkeletonRecords<CheckpointRecord>('checkpoints', [paths.checkpointsRootUri, paths.checkpointsIndexUri], 'checkpoint'),
    loadSkeletonRecords<CheckpointTimelineAnchorRecord>('checkpointTimelineAnchors', [paths.checkpointTimelineAnchorsRootUri, paths.checkpointTimelineAnchorsIndexUri], 'anchor')
  ]);

  state.projectContexts = projectContexts;
  state.conversationProjectLinks = conversationProjectLinks;
  state.workEnvironments = workEnvironments;
  state.conversationWorkEnvironmentLinks = conversationWorkEnvironmentLinks;
  state.runWorkEnvironmentLinks = runWorkEnvironmentLinks;
  state.workEnvironmentPolicies = workEnvironmentPolicies;
  state.workEnvironmentPolicyScopeLinks = workEnvironmentPolicyScopeLinks;
  state.checkpointPolicies = checkpointPolicies;
  state.checkpointPolicyScopeLinks = checkpointPolicyScopeLinks;
  state.shadowRepositories = shadowRepositories;
  state.conversationCheckpointRepositoryLinks = conversationCheckpointRepositoryLinks;
  state.checkpoints = checkpoints;
  state.checkpointTimelineAnchors = checkpointTimelineAnchors;
}

export async function saveClientStateSkeletonToStores(paths: StoragePaths, state: ClientState): Promise<void> {
  const results = await Promise.allSettled([
    saveRecords(paths.agentsRootUri, paths.agentsIndexUri, state.agents, 'agent', (record) => record.name || record.id),
    saveRecords(paths.workflowsRootUri, paths.workflowsIndexUri, state.workflows, 'workflow', (record) => record.name || record.id),
    saveRecords(paths.planReviewPoliciesRootUri, paths.planReviewPoliciesIndexUri, state.planReviewPolicies, 'policy', (record) => record.id),
    saveRecords(paths.planReviewPolicyScopeLinksRootUri, paths.planReviewPolicyScopeLinksIndexUri, state.planReviewPolicyScopeLinks, 'link'),
    saveRecords(paths.toolPoliciesRootUri, paths.toolPoliciesIndexUri, state.toolPolicies, 'toolPolicy', (record) => record.name || record.id),
    saveRecords(paths.toolPolicyScopeLinksRootUri, paths.toolPolicyScopeLinksIndexUri, state.toolPolicyScopeLinks, 'link'),
    saveRecords(paths.skillPoliciesRootUri, paths.skillPoliciesIndexUri, state.skillPolicies, 'skillPolicy', (record) => record.name || record.id),
    saveRecords(paths.skillPolicyScopeLinksRootUri, paths.skillPolicyScopeLinksIndexUri, state.skillPolicyScopeLinks, 'link'),
    saveRecords(paths.systemPromptsRootUri, paths.systemPromptsIndexUri, state.systemPrompts, 'systemPrompt', (record) => record.name || record.id),
    saveRecords(paths.systemPromptScopeLinksRootUri, paths.systemPromptScopeLinksIndexUri, state.systemPromptScopeLinks, 'link'),
    saveRecords(paths.runtimeContextsRootUri, paths.runtimeContextsIndexUri, state.runtimeContexts, 'runtimeContext', (record) => record.name || record.id),
    saveRecords(paths.runtimeContextScopeLinksRootUri, paths.runtimeContextScopeLinksIndexUri, state.runtimeContextScopeLinks, 'link'),
    saveRecords(paths.runtimeContextSnapshotsRootUri, paths.runtimeContextSnapshotsIndexUri, state.runtimeContextSnapshots, 'snapshot', (record) => record.name || record.id),
    saveRecords(paths.conversationRuntimeContextSnapshotLinksRootUri, paths.conversationRuntimeContextSnapshotLinksIndexUri, state.conversationRuntimeContextSnapshotLinks, 'link'),
    saveRecords(paths.runRuntimeContextSnapshotLinksRootUri, paths.runRuntimeContextSnapshotLinksIndexUri, state.runRuntimeContextSnapshotLinks, 'link'),
    saveRecords(paths.modelProfilesRootUri, paths.modelProfilesIndexUri, state.modelProfiles, 'modelProfile', (record) => record.name || record.id),
    saveRecords(paths.modelProfileScopeLinksRootUri, paths.modelProfileScopeLinksIndexUri, state.modelProfileScopeLinks, 'link'),
    saveRecords(paths.conversationWorkflowSelectionsRootUri, paths.conversationWorkflowSelectionsIndexUri, state.conversationWorkflowSelections, 'selection'),
    saveRecords(...subStore(paths.conversationsRootUri, CONVERSATION_REUSE_LINKS_DIR), state.conversationReuseLinks, 'link'),
    saveRecords(...subStore(paths.conversationsRootUri, CONVERSATION_BRANCH_LINKS_DIR), state.conversationBranchLinks, 'link'),
    saveRecords(...subStore(paths.conversationsRootUri, CONVERSATION_ORIGIN_LINKS_DIR), state.conversationOriginLinks, 'link'),
    saveRecords(paths.linksRootUri, paths.linksIndexUri, state.agentConversationLinks, 'link'),
    saveRecords(paths.conversationAgentSelectionsRootUri, paths.conversationAgentSelectionsIndexUri, state.conversationAgentSelections, 'selection'),
    saveRecords(paths.agentAnswersRootUri, paths.agentAnswersIndexUri, state.agentAnswers, 'answer', (record) => record.title || record.id),
    saveRecords(paths.agentAnswerSubmissionLinksRootUri, paths.agentAnswerSubmissionLinksIndexUri, state.agentAnswerSubmissionLinks, 'link'),
    saveRecords(paths.agentAnswerTargetLinksRootUri, paths.agentAnswerTargetLinksIndexUri, state.agentAnswerTargetLinks, 'link'),
    saveRecords(paths.projectContextsRootUri, paths.projectContextsIndexUri, state.projectContexts, 'projectContext', (record) => record.name || record.id),
    saveRecords(paths.conversationProjectLinksRootUri, paths.conversationProjectLinksIndexUri, state.conversationProjectLinks, 'link'),
    saveRecords(paths.workEnvironmentsRootUri, paths.workEnvironmentsIndexUri, state.workEnvironments, 'workEnvironment', (record) => record.name || record.id),
    saveRecords(paths.workEnvironmentPoliciesRootUri, paths.workEnvironmentPoliciesIndexUri, state.workEnvironmentPolicies, 'policy', (record) => record.name || record.id),
    saveRecords(paths.workEnvironmentPolicyScopeLinksRootUri, paths.workEnvironmentPolicyScopeLinksIndexUri, state.workEnvironmentPolicyScopeLinks, 'link'),
    saveRecords(paths.conversationWorkEnvironmentLinksRootUri, paths.conversationWorkEnvironmentLinksIndexUri, state.conversationWorkEnvironmentLinks, 'link'),
    saveRecords(paths.runWorkEnvironmentLinksRootUri, paths.runWorkEnvironmentLinksIndexUri, state.runWorkEnvironmentLinks, 'link'),
    saveRecords(paths.checkpointPoliciesRootUri, paths.checkpointPoliciesIndexUri, state.checkpointPolicies, 'policy', (record) => record.name || record.id),
    saveRecords(paths.checkpointPolicyScopeLinksRootUri, paths.checkpointPolicyScopeLinksIndexUri, state.checkpointPolicyScopeLinks, 'link'),
    saveRecords(paths.shadowRepositoriesRootUri, paths.shadowRepositoriesIndexUri, state.shadowRepositories, 'shadowRepository'),
    saveRecords(paths.conversationCheckpointRepositoryLinksRootUri, paths.conversationCheckpointRepositoryLinksIndexUri, state.conversationCheckpointRepositoryLinks, 'link'),
    saveRecords(paths.checkpointsRootUri, paths.checkpointsIndexUri, state.checkpoints, 'checkpoint', (record) => record.projectDisplayPath || record.id),
    saveRecords(paths.checkpointTimelineAnchorsRootUri, paths.checkpointTimelineAnchorsIndexUri, state.checkpointTimelineAnchors, 'anchor')
  ]);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failures.length > 0) {
    const details = failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : String(failure.reason)).join('; ');
    throw new Error(`Failed to save ${failures.length} client state store(s): ${details}`);
  }
}


async function loadRecords<TRecord extends StoreRecord>(root: vscode.Uri, indexUri: vscode.Uri, recordKey: StoreKey): Promise<TRecord[]> {
  return (await loadRecordStore<TRecord, string>(root, indexUri, recordKey)) ?? [];
}

async function loadSkeletonRecords<TRecord extends StoreRecord>(
  label: string,
  location: [vscode.Uri, vscode.Uri],
  recordKey: StoreKey
): Promise<TRecord[]> {
  const [root, indexUri] = location;
  return loadRecords<TRecord>(root, indexUri, recordKey);
}


async function saveRecords<TRecord extends StoreRecord>(
  root: vscode.Uri,
  indexUri: vscode.Uri,
  records: TRecord[],
  recordKey: StoreKey,
  labelForRecord?: (record: TRecord) => string
): Promise<void> {
  await saveRecordStore<TRecord, string>(root, indexUri, records, recordKey, labelForRecord);
}

function subStore(root: vscode.Uri, dir: string): [vscode.Uri, vscode.Uri] {
  const childRoot = vscode.Uri.joinPath(root, dir);
  return [childRoot, vscode.Uri.joinPath(childRoot, INDEX_FILE)];
}

function hasAnyState(state: ClientState): boolean {
  return (Object.values(state) as unknown[]).some((value) => Array.isArray(value) && value.length > 0);
}
