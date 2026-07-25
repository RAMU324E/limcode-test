import { createEmptyClientState } from '../../shared/clientStateSchema';
import type {
  ClientState,
  CompressionBlockLlmInvocationLinkRecord,
  CompressionBlockRecord,
  CompressionBlockSourceLinkRecord,
  CompressionContextVariantRecord
} from '../../shared/protocol';
import type { ConversationId } from '../../shared/stableIds';
import { conversationShardName } from '../capabilities/vscodeStorage/naming';
import { loadCanonicalRecordStore } from './canonicalRecordStore';
import type { DurableFileSystem } from './fileDurability';

/** Strict read of the four canonical compression families. LLM invocation lookup is runtime-owned. */
export async function loadCanonicalCompressionState(
  files: DurableFileSystem,
  conversationId: ConversationId
): Promise<ClientState> {
  const shard = conversationShardName(conversationId);
  const [blocks, sourceLinks, variants, invocationLinks] = await Promise.all([
    loadCanonicalRecordStore<CompressionBlockRecord>(files, {
      rootRelativePath: `compression-blocks/conversations/${shard}`,
      recordKey: 'block',
      validateRecord: (record) => {
        if (record.conversationId !== conversationId) throw new Error(`CompressionBlock belongs to another Conversation: ${record.id}`);
      }
    }),
    loadCanonicalRecordStore<CompressionBlockSourceLinkRecord>(files, {
      rootRelativePath: `compression-block-source-links/conversations/${shard}`,
      recordKey: 'link'
    }),
    loadCanonicalRecordStore<CompressionContextVariantRecord>(files, {
      rootRelativePath: `compression-context-variants/conversations/${shard}`,
      recordKey: 'variant'
    }),
    loadCanonicalRecordStore<CompressionBlockLlmInvocationLinkRecord>(files, {
      rootRelativePath: `compression-block-llm-invocation-links/conversations/${shard}`,
      recordKey: 'link'
    })
  ]);

  const blockIds = new Set(blocks.map((record) => record.id));
  for (const link of sourceLinks) requireBlockOwner(blockIds, link.blockId, 'CompressionBlockSourceLink', link.id);
  for (const variant of variants) requireBlockOwner(blockIds, variant.blockId, 'CompressionContextVariant', variant.id);
  for (const link of invocationLinks) requireBlockOwner(blockIds, link.blockId, 'CompressionBlockLlmInvocationLink', link.id);

  const state = createEmptyClientState();
  state.compressionBlocks = blocks;
  state.compressionBlockSourceLinks = sourceLinks;
  state.compressionContextVariants = variants;
  state.compressionBlockLlmInvocationLinks = invocationLinks;
  return state;
}

function requireBlockOwner(blockIds: ReadonlySet<string>, blockId: string, family: string, id: string): void {
  if (!blockIds.has(blockId)) throw new Error(`${family} has no canonical CompressionBlock owner: ${id}`);
}
