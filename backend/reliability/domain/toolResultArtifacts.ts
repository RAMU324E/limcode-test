import type { JsonValue } from '../../../shared/conversationReliability';
import type {
  ToolCallRecord,
  ToolCallResultLinkRecord,
  ToolCallStatus
} from '../../../shared/protocol';
import type { DurableToolResultArtifactRecord } from '../toolResultTypes';
import { canonicalJson, canonicalSha256 } from '../canonicalJson';
import { stableIdFromSeed } from '../stableIdFactory';
import {
  boundJsonForModel,
  boundedToolResultPreview,
  modelResponseForToolResult,
  TOOL_RESULT_INLINE_THRESHOLD_BYTES
} from '../toolResultPayload';
import type { ConversationTransitionBuilder } from './transitionBuilder';

export interface MaterializedInlineToolResult {
  result: JsonValue;
  modelResponse: JsonValue;
  artifact: DurableToolResultArtifactRecord;
  link: ToolCallResultLinkRecord;
}

/**
 * Publishes a small/bounded control-plane Tool result as the same first-class Artifact/Link model
 * used by runtime tools. External runtime payloads must still use blob-first staging; this helper is
 * intentionally for domain-synthesized results whose full source remains elsewhere (for example an
 * AnswerPayload) or whose result is intrinsically small.
 */
export function appendBoundedInlineToolResult(
  builder: ConversationTransitionBuilder,
  input: {
    conversationId: string;
    tool: ToolCallRecord;
    status: ToolCallStatus;
    result: JsonValue;
    now: number;
    error?: string;
  }
): MaterializedInlineToolResult {
  const materialized = boundedInlineToolResult(input);
  builder
    .generatedId(materialized.artifact.id, materialized.link.id)
    .upsert('toolResultArtifacts', materialized.artifact)
    .upsert('toolCallResultLinks', materialized.link);
  return materialized;
}

export function demoteFinalToolResultLinks(
  builder: ConversationTransitionBuilder,
  links: readonly ToolCallResultLinkRecord[],
  toolCallId: string,
  now: number
): void {
  for (const link of links.filter((candidate) => candidate.toolCallId === toolCallId && candidate.role === 'final')) {
    builder.upsert('toolCallResultLinks', { ...link, role: 'audit', updatedAt: now });
  }
}

/** Returns the exact post-state produced when one final result supersedes any earlier final result. */
export function replacedFinalToolResultLinks(
  links: readonly ToolCallResultLinkRecord[],
  nextLink: ToolCallResultLinkRecord,
  now: number
): ToolCallResultLinkRecord[] {
  if (nextLink.role !== 'final') throw new Error(`Replacement ToolResultLink must be final: ${nextLink.id}`);
  return [
    ...links
      .filter((link) => link.id !== nextLink.id)
      .map((link) => link.toolCallId === nextLink.toolCallId && link.role === 'final'
        ? { ...link, role: 'audit' as const, updatedAt: now }
        : { ...link }),
    { ...nextLink }
  ];
}

/** Atomically supersedes the current final result while retaining every prior Artifact as audit history. */
export function replaceFinalToolResultLink(
  builder: ConversationTransitionBuilder,
  links: readonly ToolCallResultLinkRecord[],
  nextLink: ToolCallResultLinkRecord,
  now: number
): void {
  if (nextLink.role !== 'final') throw new Error(`Replacement ToolResultLink must be final: ${nextLink.id}`);
  demoteFinalToolResultLinks(builder, links, nextLink.toolCallId, now);
  builder.upsert('toolCallResultLinks', nextLink);
}

/** Publishes a synthesized terminal result that may supersede a proposal/review result. */
export function replaceWithBoundedInlineToolResult(
  builder: ConversationTransitionBuilder,
  links: readonly ToolCallResultLinkRecord[],
  input: {
    conversationId: string;
    tool: ToolCallRecord;
    status: ToolCallStatus;
    result: JsonValue;
    now: number;
    error?: string;
  }
): MaterializedInlineToolResult {
  const materialized = boundedInlineToolResult(input);
  builder
    .generatedId(materialized.artifact.id, materialized.link.id)
    .upsert('toolResultArtifacts', materialized.artifact);
  replaceFinalToolResultLink(builder, links, materialized.link, input.now);
  return materialized;
}

export function boundedInlineToolResult(input: {
  conversationId: string;
  tool: ToolCallRecord;
  status: ToolCallStatus;
  result: JsonValue;
  now: number;
  error?: string;
}): MaterializedInlineToolResult {
  // A synthesized control result never creates an unjournaled blob. If its source is large, retain
  // that source in its own canonical domain and persist only this deterministic bounded projection.
  const result = boundJsonForModel(cloneJson(input.result), TOOL_RESULT_INLINE_THRESHOLD_BYTES);
  const canonical = canonicalJson(result);
  const contentHash = canonicalSha256(result);
  const artifactId = stableIdFromSeed(
    'toolResultArtifact',
    `${input.conversationId}:${input.tool.id}:final:${contentHash}`
  );
  const linkId = stableIdFromSeed('relation', `tool-result:${input.tool.id}:final:${artifactId}`);
  const modelResponse = modelResponseForToolResult({
    toolName: input.tool.name,
    status: input.status,
    result,
    ...(input.error ? { error: input.error } : {})
  });
  const artifact: DurableToolResultArtifactRecord = {
    id: artifactId,
    conversationId: input.conversationId,
    contentHash,
    mediaType: 'application/json',
    byteLength: Buffer.byteLength(canonical, 'utf8'),
    storageKind: 'inline',
    inlineContent: cloneJson(result),
    preview: boundedToolResultPreview(canonical),
    modelResponse,
    createdAt: input.now
  };
  const link: ToolCallResultLinkRecord = {
    id: linkId,
    conversationId: input.conversationId,
    toolCallId: input.tool.id,
    artifactId,
    role: 'final',
    createdAt: input.now,
    updatedAt: input.now
  };
  return { result, modelResponse, artifact, link };
}

/** Removes the legacy embedded result while preserving every ToolCall-owned fact. */
export function withoutEmbeddedToolResult(tool: ToolCallRecord): ToolCallRecord {
  return tool;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
