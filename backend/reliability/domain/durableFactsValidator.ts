import { canonicalJson, canonicalSha256 } from '../canonicalJson';
import {
  TOOL_MODEL_RESPONSE_MAX_BYTES,
  TOOL_RESULT_INLINE_THRESHOLD_BYTES,
  TOOL_RESULT_PREVIEW_MAX_BYTES
} from '../toolResultPayload';
import { canonicalDurableRecordsEqual, isCanonicalSharedDurableFamily } from './durableFamilySemantics';
import { persistedModelContextProjectionFingerprint } from '../../modelContext/projectionFingerprint';
import {
  TERMINAL_TOOL_CALL_STATUSES,
  isFunctionResponsePart,
  isInlineDataPart,
  isMessageMaterializationStatus,
  isRunTerminationActor,
  isRunTerminationKind,
  isRunTerminationReasonCode,
  type InlineDataPart,
  type MessageContent
} from '../../../shared/protocol';
import type { DurableConversationFacts } from './types';
import { isConversationOperationOwner, sameOperationOwner } from './operationOwner';
import { primaryEffectKinds } from './operationStateMachine';
import { turnExecutionPolicyViolations } from './turnExecutionPolicy';
import { validateCompressionContextProjection } from './compressionValidity';
import { assertCompleteEffectiveAuthority, authoritySecurityEnvelopeHash } from '../authorityCompiler';
import { createRuntimeInboxRecords } from './runtimeInbox';

export class DurableFactsIntegrityError extends Error {
  public constructor(public readonly violations: readonly string[]) {
    super(`Durable conversation facts violate ${violations.length} invariant(s):\n${violations.map((item) => `- ${item}`).join('\n')}`);
    this.name = 'DurableFactsIntegrityError';
  }
}

/** Validates stable identity and durable foreign-key closure for one leased conversation graph. */
export function validateDurableFactsGraph(scopes: readonly DurableConversationFacts[]): void {
  if (scopes.length === 0) throw new DurableFactsIntegrityError(['durable view is empty']);
  const violations: string[] = [];
  const conversationIds = uniqueIndex(scopes.map((facts) => facts.conversation), 'conversation', violations);
  const families = arrayFamilies(scopes[0]);
  const records = new Map<keyof DurableConversationFacts, Map<string, Record<string, unknown>>>();

  for (const family of families) {
    const valuesByScope = scopes.map((facts) => facts[family] as unknown as Array<Record<string, unknown>>);
    records.set(
      family,
      isCanonicalSharedDurableFamily(family)
        ? canonicalSharedIndex(valuesByScope, String(family), violations)
        : uniqueIndex(valuesByScope.flat(), String(family), violations)
    );
  }
  const allMessages = scopes.flatMap((facts) => facts.messages);
  const allRunTerminations = scopes.flatMap((facts) => facts.runTerminations);
  const allRunContextPolicies = scopes.flatMap((facts) => facts.runContextPolicies);
  const allRunContextPolicyLinks = scopes.flatMap((facts) => facts.runContextPolicyLinks);
  const allCurrentRevisionLinks = scopes.flatMap((facts) => facts.messageCurrentRevisionLinks);
  const allMessageRevisions = scopes.flatMap((facts) => facts.messageRevisions);
  const allModelContextProjections = scopes.flatMap((facts) => facts.modelContextProjections);
  const allCompressionBlocks = scopes.flatMap((facts) => facts.compressionBlocks);
  const allCompressionContextVariants = scopes.flatMap((facts) => facts.compressionContextVariants);
  const allToolCalls = scopes.flatMap((facts) => facts.toolCalls);
  const allInteractionRequests = scopes.flatMap((facts) => facts.interactionRequests);
  const allInteractionOwnerLinks = scopes.flatMap((facts) => facts.interactionOwnerLinks);
  const allInteractionResponses = scopes.flatMap((facts) => facts.interactionResponses);
  const allAuthoritySnapshots = scopes.flatMap((facts) => facts.authoritySnapshots);
  const allAuthorityDerivationLinks = scopes.flatMap((facts) => facts.authorityDerivationLinks);
  const allRuntimeDeliveryLinks = scopes.flatMap((facts) => facts.runtimeDeliveryLinks);
  const allChildTurnLinks = scopes.flatMap((facts) => facts.childTurnLinks);
  const allRuns = scopes.flatMap((facts) => facts.turns);
  const allRunTargets = scopes.flatMap((facts) => facts.runTargets);
  const allOperations = scopes.flatMap((facts) => facts.operations);
  const allAttempts = scopes.flatMap((facts) => facts.attempts);
  const allPrimaryEffects = scopes.flatMap((facts) => facts.primaryEffects);
  const allEffectPayloads = scopes.flatMap((facts) => facts.effectPayloads);
  const allInputRevisions = scopes.flatMap((facts) => facts.inputRevisions);
  const allInvocations = scopes.flatMap((facts) => facts.invocations);
  const allRequests = scopes.flatMap((facts) => facts.requests);
  const allAnswerBridges = scopes.flatMap((facts) => facts.answerBridges);
  const allAnswerSubmissions = scopes.flatMap((facts) => facts.answerSubmissions);
  const allAnswerPayloads = scopes.flatMap((facts) => facts.answerPayloads);
  const allStreamCheckpointHeads = scopes.flatMap((facts) => facts.streamCheckpointHeads);
  const allTerminalStreamFences = scopes.flatMap((facts) => facts.terminalStreamFences);
  for (const [epoch, count] of groupedCounts(allStreamCheckpointHeads, (head) => `${head.requestId}:${head.attemptId}:${head.generation}`)) {
    if (count > 1) violations.push(`stream checkpoint epoch:${epoch} has ${count} committed heads`);
  }
  for (const [epoch, count] of groupedCounts(allTerminalStreamFences, (fence) => `${fence.requestId}:${fence.attemptId}:${fence.generation}`)) {
    if (count > 1) violations.push(`terminal stream epoch:${epoch} has ${count} fences`);
  }
  for (const [revision, count] of groupedCounts(allAnswerSubmissions, (submission) => `${submission.bridgeId}:${submission.revisionNo}`)) {
    if (count > 1) violations.push(`answer submission revision:${revision} has ${count} immutable submissions`);
  }
  for (const [target, count] of groupedCounts(
    allInteractionRequests.filter((request) => request.state === 'pending'),
    (request) => {
      const owner = allInteractionOwnerLinks.find((candidate) => candidate.interactionRequestId === request.id);
      return `${request.kind}:${owner?.sourceToolCallId ?? owner?.turnId ?? request.id}`;
    }
  )) {
    if (count > 1) violations.push(`interaction target:${target} has ${count} pending requests`);
  }
  const has = (family: keyof DurableConversationFacts, id: unknown): boolean =>
    typeof id === 'string' && records.get(family)?.has(id) === true;
  const requireRef = (owner: string, family: keyof DurableConversationFacts, id: unknown): void => {
    if (typeof id !== 'string' || !id || !has(family, id)) violations.push(`${owner} references missing ${String(family)}:${String(id)}`);
  };
  const optionalRef = (owner: string, family: keyof DurableConversationFacts, id: unknown): void => {
    if (id !== undefined) requireRef(owner, family, id);
  };
  const knownConversation = (owner: string, value: unknown): void => {
    if (typeof value !== 'string' || !conversationIds.has(value)) violations.push(`${owner} references unloaded conversation:${String(value)}`);
  };

  for (const facts of scopes) {
    const conversationId = facts.conversation.id;
    if (!Number.isFinite(facts.conversation.createdAt) || facts.conversation.createdAt < 0) {
      violations.push(`conversation:${conversationId} has invalid createdAt`);
    }
    if (!Number.isFinite(facts.conversation.lastActivityAt) || facts.conversation.lastActivityAt < facts.conversation.createdAt) {
      violations.push(`conversation:${conversationId} has invalid lastActivityAt`);
    }
    for (const message of facts.messages) {
      if (message.conversationId !== conversationId) violations.push(`message:${message.id} is stored under the wrong conversation`);
      if (!isMessageMaterializationStatus(message.status)) {
        violations.push(`message:${message.id} has invalid materialization status:${String(message.status)}`);
      }
      for (const violation of durableAttachmentViolations(message.content)) violations.push(`message:${message.id} ${violation}`);
    }
    for (const revision of facts.messageRevisions) {
      if (revision.conversationId !== conversationId) violations.push(`messageRevision:${revision.id} is stored under the wrong conversation`);
      requireRef(`messageRevision:${revision.id}`, 'messages', revision.messageId);
      for (const violation of durableAttachmentViolations(revision.content)) violations.push(`messageRevision:${revision.id} ${violation}`);
    }
    for (const run of facts.turns) {
      if (run.conversationId !== conversationId) violations.push(`run:${run.id} is stored under the wrong conversation`);
      optionalRef(`run:${run.id}`, 'turns', run.retryOfRunId);
    }
    for (const projection of facts.modelContextProjections) {
      if (projection.conversationId !== facts.conversation.id) violations.push(`modelContextProjection:${projection.id} is stored under the wrong conversation`);
      const sources = facts.modelContextProjectionSourceLinks
        .filter((link) => link.projectionId === projection.id)
        .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
      try {
        const fingerprint = persistedModelContextProjectionFingerprint(projection.contents, sources, {
          ...(projection.segments ? { segments: projection.segments } : {}),
          ...(projection.priorSummaryContents ? { priorSummaryContents: projection.priorSummaryContents } : {}),
          ...(projection.resultAddenda ? { resultAddenda: projection.resultAddenda } : {})
        });
        if (fingerprint !== projection.fingerprint) violations.push(`modelContextProjection:${projection.id} fingerprint is invalid`);
      } catch (error) {
        violations.push(`modelContextProjection:${projection.id} has invalid source metadata: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (projection.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
        violations.push(`modelContextProjection:${projection.id} contains an error diagnostic`);
      }
    }
    for (const source of facts.modelContextProjectionSourceLinks) {
      requireRef(`modelContextProjectionSource:${source.id}`, 'modelContextProjections', source.projectionId);
      if (source.conversationId !== facts.conversation.id) violations.push(`modelContextProjectionSource:${source.id} is stored under the wrong conversation`);
      const projection = allModelContextProjections.find((candidate) => candidate.id === source.projectionId);
      const sourceScopeLoaded = conversationIds.has(source.sourceConversationId);
      const externalTurnSource = projection?.purposeKind === 'turn'
        && source.sourceConversationId !== facts.conversation.id;
      if (!source.sourceConversationId) {
        violations.push(`modelContextProjectionSource:${source.id} has no source conversation ownership`);
      } else if (!sourceScopeLoaded && !externalTurnSource) {
        violations.push(`modelContextProjectionSource:${source.id} references unloaded source conversation:${source.sourceConversationId}`);
      }
      if (source.sourceKind === 'messageRevision') {
        if (sourceScopeLoaded) requireRef(`modelContextProjectionSource:${source.id}`, 'messageRevisions', source.sourceId);
        if (source.revisionId !== source.sourceId || !source.messageId) violations.push(`modelContextProjectionSource:${source.id} has invalid MessageRevision provenance`);
        const revision = allMessageRevisions.find((candidate) => candidate.id === source.sourceId);
        const message = source.messageId ? allMessages.find((candidate) => candidate.id === source.messageId) : undefined;
        if (revision && revision.conversationId !== source.sourceConversationId) violations.push(`modelContextProjectionSource:${source.id} revision belongs to another source conversation`);
        if (message && message.conversationId !== source.sourceConversationId) violations.push(`modelContextProjectionSource:${source.id} Message belongs to another source conversation`);
      } else if (source.sourceKind === 'compressionVariant') {
        if (sourceScopeLoaded) requireRef(`modelContextProjectionSource:${source.id}`, 'compressionContextVariants', source.sourceId);
        const variant = allCompressionContextVariants.find((candidate) => candidate.id === source.sourceId);
        const block = variant ? allCompressionBlocks.find((candidate) => candidate.id === variant.blockId) : undefined;
        if (block && block.conversationId !== source.sourceConversationId) violations.push(`modelContextProjectionSource:${source.id} CompressionBlock belongs to another source conversation`);
      } else if (source.sourceKind === 'runTermination') {
        if (sourceScopeLoaded) requireRef(`modelContextProjectionSource:${source.id}`, 'runTerminations', source.sourceId);
        const termination = allRunTerminations.find((candidate) => candidate.id === source.sourceId);
        const run = termination ? allRuns.find((candidate) => candidate.id === termination.runId) : undefined;
        if (run && run.conversationId !== source.sourceConversationId) violations.push(`modelContextProjectionSource:${source.id} RunTermination belongs to another source conversation`);
      } else if (source.sourceKind === 'toolCall') {
        if (sourceScopeLoaded) requireRef(`modelContextProjectionSource:${source.id}`, 'toolCalls', source.sourceId);
        const tool = allToolCalls.find((candidate) => candidate.id === source.sourceId);
        const message = tool ? allMessages.find((candidate) => candidate.id === tool.messageId) : undefined;
        if (message && message.conversationId !== source.sourceConversationId) violations.push(`modelContextProjectionSource:${source.id} ToolCall belongs to another source conversation`);
      } else if (source.sourceKind === 'runtimeContextSnapshot' && source.runId) {
        const run = allRuns.find((candidate) => candidate.id === source.runId);
        if (run && run.conversationId !== source.sourceConversationId) violations.push(`modelContextProjectionSource:${source.id} runtime snapshot Run belongs to another source conversation`);
      }
    }
    for (const link of facts.requestModelContextProjectionLinks) {
      requireRef(`requestModelContextProjection:${link.id}`, 'requests', link.requestId);
      requireRef(`requestModelContextProjection:${link.id}`, 'modelContextProjections', link.projectionId);
    }
    for (const link of facts.compressionModelContextProjectionLinks) {
      requireRef(`compressionModelContextProjection:${link.id}`, 'compressionBlocks', link.blockId);
      requireRef(`compressionModelContextProjection:${link.id}`, 'modelContextProjections', link.projectionId);
    }
    for (const termination of facts.runTerminations) {
      requireRef(`runTermination:${termination.id}`, 'turns', termination.runId);
      if (termination.id !== `run-termination:${termination.runId}`) violations.push(`runTermination:${termination.id} has non-canonical identity`);
      if (!isRunTerminationKind(termination.kind)) violations.push(`runTermination:${termination.id} has invalid kind:${String(termination.kind)}`);
      if (!isRunTerminationActor(termination.actor)) violations.push(`runTermination:${termination.id} has invalid actor:${String(termination.actor)}`);
      if (!isRunTerminationReasonCode(termination.reasonCode)) violations.push(`runTermination:${termination.id} has invalid reasonCode:${String(termination.reasonCode)}`);
      if (String(termination.interruptedPhase) === 'terminal') violations.push(`runTermination:${termination.id} cannot interrupt terminal phase`);
      if (termination.actor === 'parent_run' && !termination.triggerRunId) violations.push(`runTermination:${termination.id} has parent_run actor without triggerRunId`);
      if (termination.triggerRunId === termination.runId) violations.push(`runTermination:${termination.id} cannot be triggered by its own Run`);
    }
    for (const target of facts.runTargets) {
      requireRef(`runTarget:${target.id}`, 'turns', target.runId);
      if (target.conversationId !== conversationId) violations.push(`runTarget:${target.id} is stored under the wrong conversation`);
    }
    for (const operation of facts.operations) {
      if (!isConversationOperationOwner(operation)) requireRef(`operation:${operation.id}`, 'turns', operation.ownerRunId);
      else if ((operation as { ownerRunId?: unknown }).ownerRunId !== undefined) violations.push(`operation:${operation.id} has conflicting conversation/Run ownership`);
      if (operation.conversationId !== conversationId) violations.push(`operation:${operation.id} is stored under the wrong conversation`);
    }
    for (const attempt of facts.attempts) {
      requireRef(`attempt:${attempt.id}`, 'operations', attempt.operationId);
      if (!isConversationOperationOwner(attempt)) requireRef(`attempt:${attempt.id}`, 'turns', attempt.ownerRunId);
      else if ((attempt as { ownerRunId?: unknown }).ownerRunId !== undefined) violations.push(`attempt:${attempt.id} has conflicting conversation/Run ownership`);
      const operation = facts.operations.find((candidate) => candidate.id === attempt.operationId);
      if (operation && !sameOperationOwner(operation, attempt)) violations.push(`attempt:${attempt.id} owner differs from operation:${operation.id}`);
      if (attempt.conversationId !== conversationId) violations.push(`attempt:${attempt.id} is stored under the wrong conversation`);
    }
  }

  for (const facts of scopes) {
    for (const message of facts.messages) {
      const currentLinks = allCurrentRevisionLinks.filter((link) => link.messageId === message.id);
      if (currentLinks.length !== 1) violations.push(`message:${message.id} has ${currentLinks.length} current revision links; expected exactly one`);
    }
    for (const link of facts.messageCurrentRevisionLinks) {
      requireRef(`messageCurrentRevision:${link.id}`, 'messages', link.messageId);
      requireRef(`messageCurrentRevision:${link.id}`, 'messageRevisions', link.revisionId);
      const message = allMessages.find((candidate) => candidate.id === link.messageId);
      const revision = allMessageRevisions.find((candidate) => candidate.id === link.revisionId);
      if (revision && revision.messageId !== link.messageId) violations.push(`messageCurrentRevision:${link.id} links a revision owned by another message`);
      if (message && revision && canonicalSha256(message.content) !== canonicalSha256(revision.content)) {
        violations.push(`messageCurrentRevision:${link.id} content differs from message:${message.id}`);
      }
    }
    for (const contextPolicyLink of facts.runContextPolicyLinks) {
      requireRef(`runContextPolicyLink:${contextPolicyLink.id}`, 'turns', contextPolicyLink.runId);
      requireRef(`runContextPolicyLink:${contextPolicyLink.id}`, 'runContextPolicies', contextPolicyLink.policyId);
    }
    for (const contextPolicy of facts.runContextPolicies) {
      if (contextPolicy.conversationId !== facts.conversation.id) violations.push(`runContextPolicy:${contextPolicy.id} is stored under the wrong conversation`);
      if (!['none', 'full', 'last_n', 'since_message', 'selected_messages', 'summary'].includes(contextPolicy.historyMode)) {
        violations.push(`runContextPolicy:${contextPolicy.id} has invalid historyMode:${String(contextPolicy.historyMode)}`);
      }
    }
    for (const snapshot of facts.authoritySnapshots) {
      requireRef(`authoritySnapshot:${snapshot.id}`, 'turns', snapshot.turnId);
      knownConversation(`authoritySnapshot:${snapshot.id}`, snapshot.conversationId);
      const turn = allRuns.find((candidate) => candidate.id === snapshot.turnId);
      if (snapshot.conversationId !== facts.conversation.id || (turn && turn.conversationId !== snapshot.conversationId)) {
        violations.push(`authoritySnapshot:${snapshot.id} is stored under different conversation/Turn ownership`);
      }
      if (canonicalSha256(snapshot.authority) !== snapshot.authorityHash) {
        violations.push(`authoritySnapshot:${snapshot.id} authority hash is invalid`);
      }
      try {
        assertCompleteEffectiveAuthority(snapshot.authority);
      } catch (error) {
        violations.push(`authoritySnapshot:${snapshot.id} is incomplete: ${error instanceof Error ? error.message : String(error)}`);
      }
      for (const violation of turnExecutionPolicyViolations(snapshot.authority.executionPolicy)) {
        violations.push(`authoritySnapshot:${snapshot.id} execution policy ${violation}`);
      }
      const derivations = allAuthorityDerivationLinks.filter((link) => link.childSnapshotId === snapshot.id);
      if (snapshot.derivation === 'root' && derivations.length !== 0) {
        violations.push(`authoritySnapshot:${snapshot.id} root snapshot has ${derivations.length} derivation links`);
      }
      if ((snapshot.derivation === 'child' || snapshot.derivation === 'continuation') && derivations.length !== 1) {
        violations.push(`authoritySnapshot:${snapshot.id} ${snapshot.derivation} snapshot has ${derivations.length} derivation links`);
      }
    }
    for (const link of facts.authorityDerivationLinks) {
      requireRef(`authorityDerivation:${link.id}`, 'authoritySnapshots', link.childSnapshotId);
      requireRef(`authorityDerivation:${link.id}`, 'turns', link.childTurnId);
      knownConversation(`authorityDerivation:${link.id}`, link.childConversationId);
      const parentScopeLoaded = conversationIds.has(link.parentConversationId);
      if (parentScopeLoaded) knownConversation(`authorityDerivation:${link.id}`, link.parentConversationId);
      const parentSnapshot = allAuthoritySnapshots.find((candidate) => candidate.id === link.parentSnapshotId);
      const childSnapshot = allAuthoritySnapshots.find((candidate) => candidate.id === link.childSnapshotId);
      const parentTurn = allRuns.find((candidate) => candidate.id === link.parentTurnId);
      const childTurn = allRuns.find((candidate) => candidate.id === link.childTurnId);
      if (link.childConversationId !== facts.conversation.id) {
        violations.push(`authorityDerivation:${link.id} is stored outside its child conversation`);
      }
      if (parentScopeLoaded && !parentSnapshot) violations.push(`authorityDerivation:${link.id} references missing parent AuthoritySnapshot:${link.parentSnapshotId}`);
      if (parentSnapshot && (parentSnapshot.turnId !== link.parentTurnId || parentSnapshot.conversationId !== link.parentConversationId)) {
        violations.push(`authorityDerivation:${link.id} parent snapshot ownership differs`);
      }
      if (childSnapshot && (childSnapshot.turnId !== link.childTurnId || childSnapshot.conversationId !== link.childConversationId)) {
        violations.push(`authorityDerivation:${link.id} child snapshot ownership differs`);
      }
      if (parentTurn && parentTurn.conversationId !== link.parentConversationId) violations.push(`authorityDerivation:${link.id} parent Turn scope differs`);
      if (childTurn && childTurn.conversationId !== link.childConversationId) violations.push(`authorityDerivation:${link.id} child Turn scope differs`);
      if (!/^[0-9a-f]{64}$/.test(link.overrideDigest)) violations.push(`authorityDerivation:${link.id} has invalid override digest`);
      if (link.relation !== 'equal' && link.relation !== 'restricted') violations.push(`authorityDerivation:${link.id} has invalid relation`);
      if (parentSnapshot && childSnapshot && link.relation === 'equal') {
        try {
          if (authoritySecurityEnvelopeHash(parentSnapshot.authority) !== authoritySecurityEnvelopeHash(childSnapshot.authority)) {
            violations.push(`authorityDerivation:${link.id} declares equal but changes the parent security envelope`);
          }
        } catch (error) {
          violations.push(`authorityDerivation:${link.id} cannot validate its security envelope: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
    for (const item of facts.runtimeInboxItems) {
      const deliveries = allRuntimeDeliveryLinks.filter((delivery) => delivery.inboxItemId === item.id);
      if (deliveries.length !== 1) violations.push(`runtimeInboxItem:${item.id} has ${deliveries.length} destination delivery links; expected exactly one`);
      if (!item.sourceId.trim() || !item.dedupeKey.trim()) violations.push(`runtimeInboxItem:${item.id} has empty source/dedupe identity`);
      if (canonicalSha256(item.payload) !== item.payloadHash) violations.push(`runtimeInboxItem:${item.id} payload hash is invalid`);
      const delivery = deliveries[0];
      if (delivery) {
        const canonical = createRuntimeInboxRecords({
          kind: item.kind,
          sourceKind: item.sourceKind,
          sourceId: item.sourceId,
          dedupeKey: item.dedupeKey,
          payload: item.payload,
          occurredAt: item.occurredAt,
          createdAt: item.createdAt,
          destinationConversationId: delivery.destinationConversationId,
          ...(delivery.ownerTurnId ? { ownerTurnId: delivery.ownerTurnId } : {}),
          policy: delivery.policy
        });
        if (canonical.item.id !== item.id || canonical.delivery.id !== delivery.id) {
          violations.push(`runtimeInboxItem:${item.id} or delivery:${delivery.id} has non-canonical identity`);
        }
      }
    }
    for (const delivery of facts.runtimeDeliveryLinks) {
      requireRef(`runtimeDelivery:${delivery.id}`, 'runtimeInboxItems', delivery.inboxItemId);
      knownConversation(`runtimeDelivery:${delivery.id}`, delivery.destinationConversationId);
      if (delivery.destinationConversationId !== facts.conversation.id) violations.push(`runtimeDelivery:${delivery.id} is stored under the wrong destination conversation`);
      if (delivery.ownerTurnId && has('turns', delivery.ownerTurnId)) requireRef(`runtimeDelivery:${delivery.id}`, 'turns', delivery.ownerTurnId);
      if (delivery.targetTurnId) requireRef(`runtimeDelivery:${delivery.id}`, 'turns', delivery.targetTurnId);
      if (delivery.state === 'pending' && (delivery.targetTurnId || delivery.consumedAt || delivery.deadLetterAt)) {
        violations.push(`runtimeDelivery:${delivery.id} pending state carries terminal delivery fields`);
      }
      if (delivery.state === 'consumed' && (!delivery.consumedAt || (delivery.policy !== 'notify_only' && !delivery.targetTurnId))) {
        violations.push(`runtimeDelivery:${delivery.id} consumed state lacks required target Turn/timestamp`);
      }
      if (delivery.state === 'dead_letter' && (!delivery.deadLetterAt || !delivery.error)) {
        violations.push(`runtimeDelivery:${delivery.id} dead-letter state lacks error/timestamp`);
      }
    }
    const duplicateDedupeKeys = groupedCounts(facts.runtimeInboxItems, (item) => item.dedupeKey);
    for (const [dedupeKey, count] of duplicateDedupeKeys) {
      if (count > 1) violations.push(`runtimeInbox dedupeKey:${dedupeKey} appears ${count} times in one destination`);
    }
    for (const link of facts.messageTurnLinks) {
      requireRef(`messageTurn:${link.id}`, 'messages', link.messageId);
      requireRef(`messageTurn:${link.id}`, 'turns', link.turnId);
    }
    for (const link of facts.childTurnLinks) {
      requireRef(`childTurn:${link.id}`, 'turns', link.parentTurnId);
      knownConversation(`childTurn:${link.id}`, link.parentConversationId);
      const childScopeLoaded = conversationIds.has(link.childConversationId);
      if (childScopeLoaded) knownConversation(`childTurn:${link.id}`, link.childConversationId);
      optionalRef(`childTurn:${link.id}`, 'answerBridges', link.answerBridgeId);
      if (link.sourceToolCallId !== undefined && link.mode !== 'detached') {
        requireRef(`childTurn:${link.id}`, 'toolCalls', link.sourceToolCallId);
      }
      const parent = allRuns.find((candidate) => candidate.id === link.parentTurnId);
      const child = allRuns.find((candidate) => candidate.id === link.childTurnId);
      if (link.parentConversationId !== facts.conversation.id) violations.push(`childTurn:${link.id} is stored outside its parent conversation`);
      if (childScopeLoaded && !child) violations.push(`childTurn:${link.id} references missing child Turn:${link.childTurnId}`);
      if (parent && parent.conversationId !== link.parentConversationId) violations.push(`childTurn:${link.id} parent scope differs`);
      if (child && child.conversationId !== link.childConversationId) violations.push(`childTurn:${link.id} child scope differs`);
      if (link.mode === 'foreground' && (!Number.isFinite(link.foregroundDeadlineAt)
        || link.foregroundDeadlineAt! <= link.createdAt)) {
        violations.push(`childTurn:${link.id} foreground mode has no valid deadline`);
      }
      if (link.mode !== 'foreground' && link.foregroundDeadlineAt !== undefined) {
        violations.push(`childTurn:${link.id} non-foreground mode retains a foreground deadline`);
      }
      if (link.mode === 'detached' && (!link.detachedAt || !link.detachedReason)) {
        violations.push(`childTurn:${link.id} detached mode lacks audit metadata`);
      }
    }
    for (const preset of facts.turnExecutionPresetRevisions) {
      try {
        assertCompleteEffectiveAuthority(preset.requestedAuthority);
      } catch (error) {
        violations.push(`turnExecutionPreset:${preset.id} has incomplete authority: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (canonicalSha256({ agentId: preset.agentId, requestedAuthority: preset.requestedAuthority }) !== preset.contentHash) {
        violations.push(`turnExecutionPreset:${preset.id} content hash is invalid`);
      }
    }
    for (const source of facts.runSources) {
      requireRef(`runSource:${source.id}`, 'turns', source.runId);
      const sourceScopeLoaded = source.sourceConversationId !== undefined && conversationIds.has(source.sourceConversationId);
      if (source.sourceMessageId !== undefined && sourceScopeLoaded) requireRef(`runSource:${source.id}`, 'messages', source.sourceMessageId);
      if (source.sourceToolCallId !== undefined && sourceScopeLoaded) requireRef(`runSource:${source.id}`, 'toolCalls', source.sourceToolCallId);
      if (source.sourceRunId !== undefined && (sourceScopeLoaded || has('turns', source.sourceRunId))) requireRef(`runSource:${source.id}`, 'turns', source.sourceRunId);
      // Child-side source facts intentionally reference an AnswerBridge owned by another scope.
      if (source.answerBridgeId !== undefined && has('answerBridges', source.answerBridgeId)) {
        requireRef(`runSource:${source.id}`, 'answerBridges', source.answerBridgeId);
      }
    }
    for (const link of facts.toolRunLinks) {
      requireRef(`toolRun:${link.id}`, 'toolCalls', link.toolCallId);
      requireRef(`toolRun:${link.id}`, 'turns', link.runId);
    }
    for (const run of facts.turns) {
      const executorTargetCount = allRunTargets.filter((target) => target.runId === run.id && target.role === 'executor').length;
      if (executorTargetCount !== 1) violations.push(`run:${run.id} has ${executorTargetCount} executor targets`);
      const authoritySnapshots = allAuthoritySnapshots.filter((snapshot) => snapshot.turnId === run.id);
      if (authoritySnapshots.length !== 1) violations.push(`run:${run.id} has ${authoritySnapshots.length} AuthoritySnapshots; expected exactly one`);
      const executorTarget = allRunTargets.find((target) => target.runId === run.id && target.role === 'executor');
      const authorityAgent = authoritySnapshots[0]?.authority.agent;
      const authorityAgentId = authorityAgent !== null && typeof authorityAgent === 'object' && !Array.isArray(authorityAgent)
        ? authorityAgent.id
        : undefined;
      if (executorTarget && authoritySnapshots.length === 1 && authorityAgentId !== executorTarget.agentId) {
        violations.push(`run:${run.id} AuthoritySnapshot Agent ${String(authorityAgentId)} differs from executor ${executorTarget.agentId}`);
      }
      const incomingChildLinks = allChildTurnLinks.filter((link) => link.childTurnId === run.id);
      if (incomingChildLinks.length > 1) violations.push(`run:${run.id} has ${incomingChildLinks.length} parent ChildTurnLinks`);
      if (incomingChildLinks.length === 1 && authoritySnapshots[0]?.derivation !== 'child') {
        violations.push(`run:${run.id} is a child Turn but its AuthoritySnapshot is not child-derived`);
      }
      if (incomingChildLinks.length === 0 && authoritySnapshots[0]?.derivation === 'child') {
        const derivation = allAuthorityDerivationLinks.find((link) => link.childSnapshotId === authoritySnapshots[0]?.id);
        if (!derivation || conversationIds.has(derivation.parentConversationId)) {
          violations.push(`run:${run.id} has child-derived authority but no parent ChildTurnLink`);
        }
      }
      const contextPolicyLinks = allRunContextPolicyLinks.filter((link) => link.runId === run.id && link.role === 'active');
      if (contextPolicyLinks.length !== 1) violations.push(`run:${run.id} has ${contextPolicyLinks.length} active ContextPolicy links`);
      const contextPolicy = contextPolicyLinks[0]
        ? allRunContextPolicies.find((policy) => policy.id === contextPolicyLinks[0].policyId)
        : undefined;
      if (contextPolicy && contextPolicy.conversationId !== run.conversationId) {
        violations.push(`runContextPolicy:${contextPolicy.id} is stored under different conversation ownership`);
      }
      if (contextPolicyLinks[0] && contextPolicyLinks[0].id !== `run-context-policy-link:${run.id}`) {
        violations.push(`runContextPolicyLink:${contextPolicyLinks[0].id} has non-canonical identity`);
      }
      if (contextPolicy && contextPolicy.id !== `run-context-policy:${run.id}`) {
        violations.push(`runContextPolicy:${contextPolicy.id} has non-canonical identity`);
      }
      const requestProjectionCounts = allRequests
        .filter((request) => request.runId === run.id && (request.state === 'streaming' || request.state === 'complete'))
        .map((request) => ({ request, count: scopes.flatMap((scope) => scope.requestModelContextProjectionLinks).filter((link) => link.requestId === request.id && link.role === 'input').length }));
      for (const { request, count } of requestProjectionCounts) {
        if (count !== 1) violations.push(`request:${request.id} has ${count} input ModelContextProjection links`);
      }
      const terminations = allRunTerminations.filter((termination) => termination.runId === run.id);
      const requiresTermination = run.phase === 'terminal' && run.lifecycle !== 'completed';
      const expectedTerminationCount = requiresTermination ? 1 : 0;
      if (terminations.length !== expectedTerminationCount) {
        violations.push(`run:${run.id} has ${terminations.length} termination facts; expected ${expectedTerminationCount}`);
      }
      const termination = terminations[0];
      if (termination && termination.kind !== run.lifecycle) {
        violations.push(`runTermination:${termination.id} kind differs from run:${run.id} lifecycle`);
      }
      if (termination && run.completedAt !== undefined && termination.createdAt !== run.completedAt) {
        violations.push(`runTermination:${termination.id} timestamp differs from run:${run.id} completion`);
      }
    }
    for (const slot of facts.executionLeases) {
      requireRef(`slot:${slot.id}`, 'turns', slot.turnId);
      if (slot.conversationId !== facts.conversation.id) violations.push(`slot:${slot.id} is stored under the wrong conversation`);
      const run = allRuns.find((candidate) => candidate.id === slot.turnId);
      if (run && run.conversationId !== slot.conversationId) violations.push(`slot:${slot.id} owner Run belongs to another conversation`);
    }
    for (const input of facts.inputRevisions) {
      requireRef(`inputRevision:${input.id}`, 'turns', input.runId);
      requireRef(`inputRevision:${input.id}`, 'messages', input.messageId);
      requireRef(`inputRevision:${input.id}`, 'messageRevisions', input.revisionId);
      const run = allRuns.find((candidate) => candidate.id === input.runId);
      const message = allMessages.find((candidate) => candidate.id === input.messageId);
      const revision = allMessageRevisions.find((candidate) => candidate.id === input.revisionId);
      if (input.conversationId !== facts.conversation.id || (run && run.conversationId !== input.conversationId)) {
        violations.push(`inputRevision:${input.id} is stored under different conversation ownership`);
      }
      if (revision && (revision.messageId !== input.messageId || revision.conversationId !== input.conversationId)) {
        violations.push(`inputRevision:${input.id} revision ownership differs from its frozen Message`);
      }
      if (message && message.conversationId !== input.conversationId) violations.push(`inputRevision:${input.id} Message belongs to another conversation`);
      if (revision && canonicalSha256(revision.content) !== input.contentHash) violations.push(`inputRevision:${input.id} content hash is invalid`);
    }
    for (const snapshot of facts.contextSnapshots) {
      requireRef(`contextSnapshot:${snapshot.id}`, 'turns', snapshot.runId);
      requireRef(`contextSnapshot:${snapshot.id}`, 'messageRevisions', snapshot.inputRevisionId);
      const revision = allMessageRevisions.find((candidate) => candidate.id === snapshot.inputRevisionId);
      const input = allInputRevisions.find((candidate) => candidate.runId === snapshot.runId && candidate.revisionId === snapshot.inputRevisionId);
      if (snapshot.conversationId !== facts.conversation.id) violations.push(`contextSnapshot:${snapshot.id} is stored under the wrong conversation`);
      if (revision && canonicalSha256(revision.content) !== snapshot.contentHash) violations.push(`contextSnapshot:${snapshot.id} content hash is invalid`);
      if (input && input.contentHash !== snapshot.contentHash) violations.push(`contextSnapshot:${snapshot.id} differs from frozen inputRevision:${input.id}`);
    }
    for (const invocation of facts.invocations) {
      requireRef(`invocation:${invocation.id}`, 'turns', invocation.runId);
      requireRef(`invocation:${invocation.id}`, 'operations', invocation.operationId);
      requireRef(`invocation:${invocation.id}`, 'requests', invocation.requestId);
      const request = allRequests.find((candidate) => candidate.id === invocation.requestId);
      if (request && (request.invocationId !== invocation.id || request.runId !== invocation.runId || request.conversationId !== invocation.conversationId)) {
        violations.push(`invocation:${invocation.id} and request:${request.id} ownership is not reciprocal`);
      }
    }
    for (const request of facts.requests) {
      requireRef(`request:${request.id}`, 'turns', request.runId);
      requireRef(`request:${request.id}`, 'invocations', request.invocationId);
      requireRef(`request:${request.id}`, 'operations', request.operationId);
      optionalRef(`request:${request.id}`, 'messages', request.modelMessageId);
      const invocation = allInvocations.find((candidate) => candidate.id === request.invocationId);
      if (invocation && invocation.requestId !== request.id) {
        violations.push(`request:${request.id} is not the current request of invocation:${invocation.id}`);
      }
    }
    for (const tool of facts.toolCalls) {
      requireRef(`toolCall:${tool.id}`, 'messages', tool.messageId);
      if (tool.responseParts?.length) {
        for (const violation of durableAttachmentViolations({ role: 'user', parts: tool.responseParts })) {
          violations.push(`toolCall:${tool.id} response ${violation}`);
        }
      }
    }
    for (const [messageId, batch] of groupBy(facts.toolCalls, (tool) => tool.messageId)) {
      const ordinals = batch.map((tool) => tool.schedulingOrdinal).filter((ordinal): ordinal is number => Number.isInteger(ordinal) && ordinal! >= 0);
      if (ordinals.length !== batch.length || new Set(ordinals).size !== batch.length
        || [...ordinals].sort((left, right) => left - right).some((ordinal, index) => ordinal !== index)) {
        violations.push(`tool batch:${messageId} scheduling ordinals are not unique and contiguous`);
      }
      if (batch.some((tool) => tool.schedulingMode !== 'parallel' && tool.schedulingMode !== 'serial')) {
        violations.push(`tool batch:${messageId} has an invalid scheduling mode`);
      }
    }
    for (const tool of facts.toolCalls.filter((candidate) => TERMINAL_TOOL_CALL_STATUSES.has(candidate.status))) {
      if (!facts.toolCallResultLinks.some((link) => link.toolCallId === tool.id && link.role === 'final')) {
        violations.push(`terminal toolCall:${tool.id} has no final result Artifact`);
      }
    }
    for (const artifact of facts.toolResultArtifacts) {
      knownConversation(`toolResultArtifact:${artifact.id}`, artifact.conversationId);
      if (!/^[0-9a-f]{64}$/.test(artifact.contentHash)
        || artifact.mediaType !== 'application/json'
        || !Number.isInteger(artifact.byteLength) || artifact.byteLength < 0
        || typeof artifact.preview !== 'string'
        || Buffer.byteLength(artifact.preview, 'utf8') > TOOL_RESULT_PREVIEW_MAX_BYTES
        || !Number.isFinite(artifact.createdAt) || artifact.createdAt < 0) {
        violations.push(`toolResultArtifact:${artifact.id} has invalid metadata`);
      }
      if (artifact.storageKind === 'inline') {
        if (artifact.inlineContent === undefined || artifact.blobHash !== undefined
          || canonicalSha256(artifact.inlineContent) !== artifact.contentHash
          || Buffer.byteLength(canonicalJson(artifact.inlineContent), 'utf8') !== artifact.byteLength
          || artifact.byteLength > TOOL_RESULT_INLINE_THRESHOLD_BYTES) {
          violations.push(`toolResultArtifact:${artifact.id} has invalid inline content`);
        }
      } else if (artifact.storageKind === 'blob') {
        if (artifact.inlineContent !== undefined || artifact.blobHash !== artifact.contentHash) {
          violations.push(`toolResultArtifact:${artifact.id} has invalid blob reference`);
        }
      } else {
        violations.push(`toolResultArtifact:${artifact.id} has invalid storage kind`);
      }
      try {
        if (Buffer.byteLength(canonicalJson(artifact.modelResponse), 'utf8') > TOOL_MODEL_RESPONSE_MAX_BYTES) {
          violations.push(`toolResultArtifact:${artifact.id} has an oversized model response`);
        }
      } catch { violations.push(`toolResultArtifact:${artifact.id} has a non-JSON model response`); }
    }
    for (const link of facts.toolCallResultLinks) {
      knownConversation(`toolCallResultLink:${link.id}`, link.conversationId);
      requireRef(`toolCallResultLink:${link.id}`, 'toolCalls', link.toolCallId);
      requireRef(`toolCallResultLink:${link.id}`, 'toolResultArtifacts', link.artifactId);
      const artifact = facts.toolResultArtifacts.find((candidate) => candidate.id === link.artifactId);
      if (artifact && artifact.conversationId !== link.conversationId) {
        violations.push(`toolCallResultLink:${link.id} crosses Artifact conversation ownership`);
      }
    }
    for (const [toolCallId, links] of groupBy(facts.toolCallResultLinks, (link) => link.toolCallId)) {
      const finalLinks = links.filter((link) => link.role === 'final');
      if (finalLinks.length > 1) violations.push(`toolCall:${toolCallId} has ${finalLinks.length} final result links`);
      const tool = facts.toolCalls.find((candidate) => candidate.id === toolCallId);
      if (tool && TERMINAL_TOOL_CALL_STATUSES.has(tool.status) && finalLinks.length !== 1) {
        violations.push(`terminal toolCall:${toolCallId} has ${finalLinks.length} final result links`);
      }
    }
    for (const artifact of facts.toolResultArtifacts) {
      if (!facts.toolCallResultLinks.some((link) => link.artifactId === artifact.id)) {
        violations.push(`toolResultArtifact:${artifact.id} has no ToolCallResultLink owner`);
      }
    }
    for (const event of facts.toolCallEvents) {
      requireRef(`toolCallEvent:${event.id}`, 'toolCalls', event.toolCallId);
      if (event.kind === 'progress' || event.kind === 'stdout' || event.kind === 'stderr' || event.delta !== undefined) {
        violations.push(`toolCallEvent:${event.id} persists transient output/progress`);
      }
      if ((event.kind === 'completed' || event.kind === 'failed') && event.payload !== undefined) {
        violations.push(`toolCallEvent:${event.id} duplicates a terminal result payload`);
      }
    }
    for (const execution of facts.toolExecutions) {
      requireRef(`toolExecution:${execution.id}`, 'toolCalls', execution.id);
      requireRef(`toolExecution:${execution.id}`, 'turns', execution.runId);
      requireRef(`toolExecution:${execution.id}`, 'operations', execution.operationId);
    }

    for (const block of facts.compressionBlocks) {
      knownConversation(`compressionBlock:${block.id}`, block.conversationId);
      optionalRef(`compressionBlock:${block.id}`, 'messages', block.anchorMessageId);
      if (block.status === 'complete') {
        const validity = validateCompressionContextProjection(facts, block.id);
        if (!validity.valid) {
          violations.push(`compressionBlock:${block.id} has an invalid source graph:${validity.reason ?? 'unknown'}`);
        }
        if (!block.compressionConfigSnapshot || block.compressionConfigSnapshot.kind !== block.methodKind) {
          violations.push(`compressionBlock:${block.id} has no matching compression configuration snapshot`);
        }
        const providerBacked = block.methodKind === 'openai_responses_compact'
          || block.methodKind === 'llm_summary'
          || block.methodKind === 'segmented_summary';
        if (providerBacked && !block.providerSettingsSnapshot) {
          violations.push(`compressionBlock:${block.id} has no Provider settings snapshot`);
        }
      }
    }
    for (const link of facts.compressionBlockSourceLinks) {
      requireRef(`compressionSource:${link.id}`, 'compressionBlocks', link.blockId);
      if (link.sourceKind === 'message') requireRef(`compressionSource:${link.id}`, 'messages', link.sourceId);
      else requireRef(`compressionSource:${link.id}`, 'compressionBlocks', link.sourceId);
      optionalRef(`compressionSource:${link.id}`, 'messageRevisions', link.revisionId);
    }
    for (const variant of facts.compressionContextVariants) requireRef(`compressionVariant:${variant.id}`, 'compressionBlocks', variant.blockId);
    for (const link of facts.compressionBlockLlmInvocationLinks) requireRef(`compressionInvocation:${link.id}`, 'compressionBlocks', link.blockId);
    for (const link of facts.runCompressionBlockLinks) {
      requireRef(`runCompression:${link.id}`, 'turns', link.runId);
      requireRef(`runCompression:${link.id}`, 'compressionBlocks', link.blockId);
      optionalRef(`runCompression:${link.id}`, 'compressionContextVariants', link.variantId);
    }

    for (const repositoryLink of facts.conversationCheckpointRepositoryLinks) {
      knownConversation(`checkpointRepository:${repositoryLink.id}`, repositoryLink.conversationId);
      requireRef(`checkpointRepository:${repositoryLink.id}`, 'shadowRepositories', repositoryLink.shadowRepositoryId);
      requireRef(`checkpointRepository:${repositoryLink.id}`, 'projectContexts', repositoryLink.projectContextId);
    }
    for (const checkpoint of facts.checkpoints) {
      knownConversation(`checkpoint:${checkpoint.id}`, checkpoint.conversationId);
      requireRef(`checkpoint:${checkpoint.id}`, 'shadowRepositories', checkpoint.shadowRepositoryId);
      requireRef(`checkpoint:${checkpoint.id}`, 'projectContexts', checkpoint.projectContextId);
    }
    for (const anchor of facts.checkpointTimelineAnchors) {
      knownConversation(`checkpointAnchor:${anchor.id}`, anchor.conversationId);
      requireRef(`checkpointAnchor:${anchor.id}`, 'checkpoints', anchor.checkpointId);
      requireRef(`checkpointAnchor:${anchor.id}`, 'messages', anchor.floorMessageId);
      optionalRef(`checkpointAnchor:${anchor.id}`, 'turns', anchor.sourceRunId);
    }

    for (const operation of facts.operations.filter((candidate) => candidate.state === 'pending' || candidate.state === 'running')) {
      const attempts = allAttempts.filter((attempt) => attempt.operationId === operation.id
        && attempt.generation === operation.currentGeneration
        && (attempt.state === 'pending' || attempt.state === 'dispatched'));
      const effects = attempts.length === 1
        ? allPrimaryEffects.filter((effect) => effect.operationId === operation.id
          && effect.attemptId === attempts[0].id
          && effect.generation === operation.currentGeneration)
        : [];
      if (effects.length !== 1) violations.push(`active operation:${operation.id} has ${effects.length} current primary effect descriptors`);
    }
    for (const effect of facts.primaryEffects) {
      requireRef(`primaryEffect:${effect.effectIntentId}`, 'operations', effect.operationId);
      requireRef(`primaryEffect:${effect.effectIntentId}`, 'attempts', effect.attemptId);
      if (!isConversationOperationOwner(effect)) requireRef(`primaryEffect:${effect.effectIntentId}`, 'turns', effect.ownerRunId);
      const operation = allOperations.find((candidate) => candidate.id === effect.operationId);
      const attempt = allAttempts.find((candidate) => candidate.id === effect.attemptId);
      const payload = allEffectPayloads.find((candidate) => candidate.id === effect.payloadRef.id);
      if (operation && !sameOperationOwner(operation, effect)) violations.push(`primaryEffect:${effect.effectIntentId} owner differs from operation:${operation.id}`);
      if (attempt && !sameOperationOwner(attempt, effect)) violations.push(`primaryEffect:${effect.effectIntentId} owner differs from attempt:${attempt.id}`);
      if (operation && operation.kind !== effect.kind) violations.push(`primaryEffect:${effect.effectIntentId} kind differs from operation:${operation.id}`);
      if (attempt && (attempt.operationId !== effect.operationId || attempt.generation !== effect.generation)) violations.push(`primaryEffect:${effect.effectIntentId} generation differs from attempt:${attempt.id}`);
      if (attempt && attempt.deadlineAt !== effect.deadlineAt) violations.push(`primaryEffect:${effect.effectIntentId} deadline differs from attempt:${attempt.id}`);
      try {
        if (primaryEffectKinds.require(effect.kind).recoveryPolicy !== effect.recoveryPolicy) {
          violations.push(`primaryEffect:${effect.effectIntentId} recovery policy drifted from kind:${effect.kind}`);
        }
      } catch {
        violations.push(`primaryEffect:${effect.effectIntentId} has unregistered kind:${effect.kind}`);
      }
      if (effect.payloadRef.kind === 'released') {
        if (attempt?.state !== 'dispatched') violations.push(`primaryEffect:${effect.effectIntentId} released payload before durable dispatch`);
        if (effect.kind !== 'llm.request') violations.push(`primaryEffect:${effect.effectIntentId} released payload for unsupported kind:${effect.kind}`);
        if (payload) violations.push(`primaryEffect:${effect.effectIntentId} retains effectPayload:${payload.id} after release`);
      } else {
        requireRef(`primaryEffect:${effect.effectIntentId}`, 'effectPayloads', effect.payloadRef.id);
        if (payload && (payload.operationId !== effect.operationId || payload.kind !== effect.kind || payload.payloadHash !== effect.payloadRef.hash)) {
          violations.push(`primaryEffect:${effect.effectIntentId} payload identity/hash differs from effectPayload:${payload.id}`);
        }
      }
    }
    for (const payload of facts.effectPayloads) {
      requireRef(`effectPayload:${payload.id}`, 'operations', payload.operationId);
      if (!isConversationOperationOwner(payload)) requireRef(`effectPayload:${payload.id}`, 'turns', payload.ownerRunId);
      const operation = allOperations.find((candidate) => candidate.id === payload.operationId);
      if (operation && !sameOperationOwner(operation, payload)) violations.push(`effectPayload:${payload.id} owner differs from operation:${operation.id}`);
      if (operation && operation.kind !== payload.kind) violations.push(`effectPayload:${payload.id} kind differs from operation:${operation.id}`);
      if (canonicalSha256(payload.payload) !== payload.payloadHash) violations.push(`effectPayload:${payload.id} payload hash is invalid`);
      if (payload.kind === 'context.load' && operation && (operation.state === 'pending' || operation.state === 'running')) {
        const contextPayload = asContextLoadPayload(payload.payload);
        if (!contextPayload) {
          violations.push(`effectPayload:${payload.id} has an invalid context.load payload`);
        } else {
          const input = allInputRevisions.find((candidate) => candidate.runId === contextPayload.runId && candidate.revisionId === contextPayload.revisionId);
          if (!input || input.contentHash !== contextPayload.inputContentHash) {
            violations.push(`effectPayload:${payload.id} differs from its frozen context input`);
          }
        }
      }
    }
    for (const request of facts.interactionRequests) {
      optionalRef(`interactionRequest:${request.id}`, 'toolResultArtifacts', request.subjectRef);
      const subjectArtifact = request.subjectRef
        ? facts.toolResultArtifacts.find((artifact) => artifact.id === request.subjectRef)
        : undefined;
      if (canonicalSha256(request.payload) !== request.payloadDigest) {
        violations.push(`interactionRequest:${request.id} payload digest is invalid`);
      }
      if (request.subjectRef && !request.subjectDigest) {
        violations.push(`interactionRequest:${request.id} has a subject Artifact without a digest`);
      }
      if (subjectArtifact && subjectArtifact.contentHash !== request.subjectDigest) {
        violations.push(`interactionRequest:${request.id} subject digest differs from subject Artifact`);
      }
      if (!Number.isInteger(request.revision) || request.revision < 1) {
        violations.push(`interactionRequest:${request.id} has invalid revision:${request.revision}`);
      }
      if (!/^[0-9a-f]{64}$/.test(request.payloadDigest)
        || !/^[0-9a-f]{64}$/.test(request.policySnapshot.policyVersion)
        || (request.subjectDigest !== undefined && !/^[0-9a-f]{64}$/.test(request.subjectDigest))) {
        violations.push(`interactionRequest:${request.id} has an invalid payload/subject/policy digest`);
      }
      if (request.choices.length === 0 || new Set(request.choices).size !== request.choices.length) {
        violations.push(`interactionRequest:${request.id} has invalid choices`);
      }
      const owners = allInteractionOwnerLinks.filter((owner) => owner.interactionRequestId === request.id);
      if (owners.length !== 1) violations.push(`interactionRequest:${request.id} has ${owners.length} owner links`);
      const responses = allInteractionResponses.filter((response) =>
        response.interactionRequestId === request.id && response.interactionRevision === request.revision);
      if (request.state === 'pending') {
        if (responses.length !== 0) violations.push(`interactionRequest:${request.id} is pending with ${responses.length} responses`);
      } else if (responses.length !== 1) {
        violations.push(`interactionRequest:${request.id} is terminal with ${responses.length} responses`);
      }
      const notBeforeAt = request.policySnapshot.notBeforeAt;
      if (request.policySnapshot.mode === 'auto_at' && (!Number.isFinite(notBeforeAt) || notBeforeAt! < request.createdAt)) {
        violations.push(`interactionRequest:${request.id} has an invalid auto deadline`);
      }
      if (request.policySnapshot.mode === 'auto_immediate' && notBeforeAt !== request.createdAt) {
        violations.push(`interactionRequest:${request.id} immediate policy does not start at creation`);
      }
      if (request.policySnapshot.mode === 'manual' && (request.policySnapshot.autoDecision !== undefined || notBeforeAt !== undefined)) {
        violations.push(`interactionRequest:${request.id} manual policy contains an automatic decision/deadline`);
      }
      if ((request.kind === 'patch_approval' || request.kind === 'result_review') && !request.subjectRef) {
        violations.push(`interactionRequest:${request.id} has no immutable subject Artifact`);
      }
      if (request.kind === 'patch_approval' && (request.choices.length !== 2
        || !request.choices.includes('accept') || !request.choices.includes('reject'))) {
        violations.push(`interactionRequest:${request.id} has invalid patch approval choices`);
      }
    }
    for (const owner of facts.interactionOwnerLinks) {
      requireRef(`interactionOwner:${owner.id}`, 'interactionRequests', owner.interactionRequestId);
      requireRef(`interactionOwner:${owner.id}`, 'turns', owner.turnId);
      optionalRef(`interactionOwner:${owner.id}`, 'toolCalls', owner.sourceToolCallId);
      knownConversation(`interactionOwner:${owner.id}`, owner.conversationId);
      const turn = allRuns.find((candidate) => candidate.id === owner.turnId);
      if (owner.conversationId !== facts.conversation.id || (turn && turn.conversationId !== owner.conversationId)) {
        violations.push(`interactionOwner:${owner.id} is stored under different conversation/Turn ownership`);
      }
    }
    for (const response of facts.interactionResponses) {
      requireRef(`interactionResponse:${response.id}`, 'interactionRequests', response.interactionRequestId);
      requireRef(`interactionResponse:${response.id}`, 'turns', response.ownerTurnId);
      const request = allInteractionRequests.find((candidate) => candidate.id === response.interactionRequestId);
      const owner = allInteractionOwnerLinks.find((candidate) => candidate.interactionRequestId === response.interactionRequestId);
      if (request && response.interactionRevision !== request.revision) {
        violations.push(`interactionResponse:${response.id} revision differs from request:${request.id}`);
      }
      if (owner && response.ownerTurnId !== owner.turnId) {
        violations.push(`interactionResponse:${response.id} owner differs from interaction owner:${owner.id}`);
      }
      if (request && !request.choices.includes(response.decision)) {
        violations.push(`interactionResponse:${response.id} decision is not allowed by request:${request.id}`);
      }
      if (canonicalSha256(response.payload) !== response.payloadHash) {
        violations.push(`interactionResponse:${response.id} payload hash is invalid`);
      }
    }
    for (const pause of facts.pauses) {
      requireRef(`pause:${pause.id}`, 'turns', pause.runId);
      requireRef(`pause:${pause.id}`, 'operations', pause.operationId);
    }
    for (const resolution of facts.operationResolutions) requireRef(`operationResolution:${resolution.id}`, 'operations', resolution.operationId);

    for (const bridge of facts.answerBridges) {
      requireRef(`answerBridge:${bridge.id}`, 'turns', bridge.ownerRunId);
      knownConversation(`answerBridge:${bridge.id}`, bridge.sourceConversationId);
      if (conversationIds.has(bridge.targetConversationId)) knownConversation(`answerBridge:${bridge.id}`, bridge.targetConversationId);
      optionalRef(`answerBridge:${bridge.id}`, 'answerSubmissions', bridge.currentSubmissionId);
      const owner = allRuns.find((candidate) => candidate.id === bridge.ownerRunId);
      const submissions = allAnswerSubmissions.filter((candidate) => candidate.bridgeId === bridge.id);
      const currentSubmission = allAnswerSubmissions.find((candidate) => candidate.id === bridge.currentSubmissionId);
      if (bridge.sourceConversationId !== facts.conversation.id || (owner && owner.conversationId !== bridge.sourceConversationId)) {
        violations.push(`answerBridge:${bridge.id} is stored under different source/Run ownership`);
      }
      if (submissions.length > 0 && !bridge.currentSubmissionId) violations.push(`answerBridge:${bridge.id} has immutable submissions but no current submission`);
      if (currentSubmission && currentSubmission.bridgeId !== bridge.id) violations.push(`answerBridge:${bridge.id} current submission belongs to another bridge`);
      const latestRevisionNo = submissions.reduce((latest, submission) => Math.max(latest, submission.revisionNo), 0);
      if (currentSubmission && currentSubmission.revisionNo !== latestRevisionNo) {
        violations.push(`answerBridge:${bridge.id} current submission is not the latest immutable revision`);
      }
    }
    for (const submission of facts.answerSubmissions) {
      requireRef(`answerSubmission:${submission.id}`, 'answerBridges', submission.bridgeId);
      requireRef(`answerSubmission:${submission.id}`, 'answerPayloads', submission.payloadRef);
      const bridge = allAnswerBridges.find((candidate) => candidate.id === submission.bridgeId);
      const payload = allAnswerPayloads.find((candidate) => candidate.id === submission.payloadRef);
      if (bridge && bridge.sourceConversationId !== facts.conversation.id) violations.push(`answerSubmission:${submission.id} is stored outside its bridge source conversation`);
      if (payload && (payload.bridgeId !== submission.bridgeId || payload.submissionId !== submission.id)) {
        violations.push(`answerSubmission:${submission.id} payload ownership is inconsistent`);
      }
      if (!Number.isInteger(submission.revisionNo) || submission.revisionNo < 1) violations.push(`answerSubmission:${submission.id} has an invalid revision number`);
    }
    for (const payload of facts.answerPayloads) {
      requireRef(`answerPayload:${payload.id}`, 'answerBridges', payload.bridgeId);
      requireRef(`answerPayload:${payload.id}`, 'answerSubmissions', payload.submissionId);
      const bridge = allAnswerBridges.find((candidate) => candidate.id === payload.bridgeId);
      const submission = allAnswerSubmissions.find((candidate) => candidate.id === payload.submissionId);
      if (bridge && bridge.sourceConversationId !== facts.conversation.id) violations.push(`answerPayload:${payload.id} is stored outside its bridge source conversation`);
      if (submission && (submission.bridgeId !== payload.bridgeId || submission.payloadRef !== payload.id)) {
        violations.push(`answerPayload:${payload.id} submission ownership is inconsistent`);
      }
      if (canonicalSha256({ title: payload.title, content: payload.content }) !== payload.payloadHash) violations.push(`answerPayload:${payload.id} payload hash is invalid`);
    }
    for (const head of facts.streamCheckpointHeads) {
      requireRef(`streamCheckpoint:${head.id}`, 'requests', head.requestId);
      requireRef(`streamCheckpoint:${head.id}`, 'attempts', head.attemptId);
      const request = facts.requests.find((candidate) => candidate.id === head.requestId);
      const attempt = facts.attempts.find((candidate) => candidate.id === head.attemptId);
      if (request && request.state !== 'streaming') violations.push(`streamCheckpoint:${head.id} belongs to non-streaming request:${request.id}`);
      if (attempt && attempt.state !== 'dispatched') violations.push(`streamCheckpoint:${head.id} belongs to non-dispatched attempt:${attempt.id}`);
      if (request && attempt && (attempt.operationId !== request.operationId || attempt.generation !== head.generation)) {
        violations.push(`streamCheckpoint:${head.id} epoch ownership differs from request/attempt`);
      }
      if (request && head.streamSeq > (request.streamSeq ?? 0)) violations.push(`streamCheckpoint:${head.id} is ahead of request:${request.id}`);
      if (head.resolvedContent && head.resolvedContent.role !== 'model') violations.push(`streamCheckpoint:${head.id} has non-model recovered content`);
      if (head.resolvedContent) {
        for (const violation of durableAttachmentViolations(head.resolvedContent)) {
          violations.push(`streamCheckpoint:${head.id} ${violation}`);
        }
      }
    }
    for (const fence of facts.terminalStreamFences) {
      requireRef(`streamFence:${fence.id}`, 'requests', fence.requestId);
      requireRef(`streamFence:${fence.id}`, 'attempts', fence.attemptId);
      const request = facts.requests.find((candidate) => candidate.id === fence.requestId);
      const attempt = facts.attempts.find((candidate) => candidate.id === fence.attemptId);
      if (request && (request.state === 'pending' || request.state === 'streaming')) violations.push(`streamFence:${fence.id} belongs to non-terminal request:${request.id}`);
      if (attempt && (attempt.state === 'pending' || attempt.state === 'dispatched')) violations.push(`streamFence:${fence.id} belongs to non-terminal attempt:${attempt.id}`);
      if (request && attempt && (attempt.operationId !== request.operationId || attempt.generation !== fence.generation)) {
        violations.push(`streamFence:${fence.id} epoch ownership differs from request/attempt`);
      }
      if (request && fence.finalStreamSeq > (request.streamSeq ?? 0)) violations.push(`streamFence:${fence.id} is ahead of request:${request.id}`);
    }
  }

  if (violations.length > 0) throw new DurableFactsIntegrityError(violations);
}

function groupBy<T>(records: readonly T[], keyOf: (record: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const record of records) {
    const key = keyOf(record);
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  return groups;
}

function durableAttachmentViolations(content: MessageContent): string[] {
  const violations: string[] = [];
  const inspect = (part: InlineDataPart): void => {
    const value = part.inlineData;
    if (typeof value.data === 'string' && value.data.length > 0) violations.push('contains embedded attachment bytes');
    const attachmentId = typeof value.attachmentId === 'string' && value.attachmentId.trim().length > 0;
    const sourcePath = typeof value.sourcePath === 'string' && value.sourcePath.trim().length > 0;
    if (attachmentId && sourcePath) violations.push('attachment has conflicting managed and local references');
    if (attachmentId && value.storage !== 'managed') violations.push('managed attachment has an invalid storage mode');
    if (sourcePath && value.storage !== 'localPath') violations.push('local attachment has an invalid storage mode');
    const unavailable = value.status === 'tooLarge' || value.status === 'unsupported' || value.status === 'missing' || value.status === 'failed';
    if (!attachmentId && !sourcePath && !unavailable) violations.push('attachment has no durable reference');
    if (value.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(value.sha256)) violations.push('attachment has an invalid SHA-256');
  };
  for (const part of content.parts) {
    if (isInlineDataPart(part)) inspect(part);
    else if (isFunctionResponsePart(part)) for (const nested of part.functionResponse.parts ?? []) inspect(nested);
  }
  return violations;
}

function asContextLoadPayload(value: unknown): { runId: string; revisionId: string; inputContentHash: string } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.runId === 'string'
    && typeof candidate.revisionId === 'string'
    && typeof candidate.inputContentHash === 'string'
    ? { runId: candidate.runId, revisionId: candidate.revisionId, inputContentHash: candidate.inputContentHash }
    : undefined;
}

function groupedCounts<T>(records: readonly T[], keyOf: (record: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    const key = keyOf(record);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function uniqueIndex<T extends { id?: unknown }>(records: readonly T[], label: string, violations: string[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const record of records) {
    if (typeof record.id !== 'string' || !record.id) {
      violations.push(`${label} has an empty durable ID`);
      continue;
    }
    if (result.has(record.id)) violations.push(`${label}:${record.id} is not unique in the leased durable view`);
    else result.set(record.id, record);
  }
  return result;
}

function canonicalSharedIndex<T extends { id?: unknown }>(
  recordsByScope: readonly (readonly T[])[],
  label: string,
  violations: string[]
): Map<string, T> {
  const result = new Map<string, T>();
  for (const scopeRecords of recordsByScope) {
    const scopeIds = new Set<string>();
    for (const record of scopeRecords) {
      if (typeof record.id !== 'string' || !record.id) {
        violations.push(`${label} has an empty durable ID`);
        continue;
      }
      if (scopeIds.has(record.id)) {
        violations.push(`${label}:${record.id} is not unique within one durable conversation scope`);
        continue;
      }
      scopeIds.add(record.id);
      const canonical = result.get(record.id);
      if (!canonical) {
        result.set(record.id, record);
        continue;
      }
      if (!canonicalDurableRecordsEqual(
        canonical as unknown as Record<string, unknown>,
        record as unknown as Record<string, unknown>
      )) {
        violations.push(`${label}:${record.id} has conflicting canonical content across leased durable scopes`);
      }
    }
  }
  return result;
}

function arrayFamilies(facts: DurableConversationFacts): Array<Exclude<keyof DurableConversationFacts, 'conversation'>> {
  return (Object.keys(facts) as Array<keyof DurableConversationFacts>)
    .filter((family): family is Exclude<keyof DurableConversationFacts, 'conversation'> => family !== 'conversation' && Array.isArray(facts[family]));
}
