import type { DurablePostimage, RecordMutation } from '../../../shared/conversationReliability';
import type {
  CompressionBlockLlmInvocationLinkRecord,
  CompressionBlockRecord,
  CompressionBlockSourceLinkRecord,
  CompressionContextVariantRecord
} from '../../../shared/protocol';
import type { ConversationId } from '../../../shared/stableIds';
import { conversationShardName } from '../../capabilities/vscodeStorage/naming';
import type { DurableConversationFacts } from '../domain/types';
import type { DurableFileSystem } from '../fileDurability';
import { compileRecordStore } from './recordStoreCompiler';

interface CompressionFamilySpec<TRecord extends { id: string }> {
  family: string;
  root: string;
  recordKey: string;
  current(facts: DurableConversationFacts): readonly TRecord[];
  next(facts: DurableConversationFacts): readonly TRecord[];
  label(record: TRecord): string;
}

export async function compileCompressionPostimages(input: {
  files: DurableFileSystem;
  conversationId: ConversationId;
  current: DurableConversationFacts;
  next: DurableConversationFacts;
  mutations: readonly RecordMutation[];
  now: number;
}): Promise<Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>>> {
  const shard = conversationShardName(input.conversationId);
  const specs: Array<CompressionFamilySpec<any>> = [
    {
      family: 'compressionBlocks',
      root: `compression-blocks/conversations/${shard}`,
      recordKey: 'block',
      current: (facts) => facts.compressionBlocks,
      next: (facts) => facts.compressionBlocks,
      label: (record: CompressionBlockRecord) => record.title || record.id
    },
    {
      family: 'compressionBlockSourceLinks',
      root: `compression-block-source-links/conversations/${shard}`,
      recordKey: 'link',
      current: (facts) => facts.compressionBlockSourceLinks,
      next: (facts) => facts.compressionBlockSourceLinks,
      label: (record: CompressionBlockSourceLinkRecord) => record.id
    },
    {
      family: 'compressionContextVariants',
      root: `compression-context-variants/conversations/${shard}`,
      recordKey: 'variant',
      current: (facts) => facts.compressionContextVariants,
      next: (facts) => facts.compressionContextVariants,
      label: (record: CompressionContextVariantRecord) => record.id
    },
    {
      family: 'compressionBlockLlmInvocationLinks',
      root: `compression-block-llm-invocation-links/conversations/${shard}`,
      recordKey: 'link',
      current: (facts) => facts.compressionBlockLlmInvocationLinks,
      next: (facts) => facts.compressionBlockLlmInvocationLinks,
      label: (record: CompressionBlockLlmInvocationLinkRecord) => record.id
    }
  ];

  const postimages: Array<Omit<DurablePostimage, 'stagingRelativePath' | 'preimageHash'>> = [];
  for (const spec of specs) {
    const touchedIds = touchedIdsForFamily(input.mutations, spec.family);
    if (touchedIds.size === 0) continue;
    const compiled = await compileRecordStore({
      files: input.files,
      rootRelativePath: spec.root,
      recordKey: spec.recordKey,
      currentRecords: spec.current(input.current),
      nextRecords: spec.next(input.next),
      touchedIds,
      now: input.now,
      labelForRecord: spec.label
    });
    postimages.push(...compiled.postimages);
  }
  return postimages.sort((left, right) => left.targetRelativePath.localeCompare(right.targetRelativePath));
}

function touchedIdsForFamily(mutations: readonly RecordMutation[], family: string): Set<string> {
  const ids = new Set<string>();
  for (const mutation of mutations) {
    if (mutation.family !== family) continue;
    if (mutation.kind === 'remove_many') {
      for (const id of mutation.ids) ids.add(id);
    } else {
      ids.add(mutation.id);
    }
  }
  return ids;
}
