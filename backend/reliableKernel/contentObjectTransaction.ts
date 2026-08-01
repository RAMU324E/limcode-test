import type { PreparedContentObject } from './contentAddressedStore';
import {
  DOMAIN_REPOSITORIES,
  savepoint,
  type RepositoryTransactionStep
} from './repositories';

/**
 * CAS bytes are already published. Each independently deduplicated ContentObject gets its own
 * savepoint, followed by an immutable identity assertion before any domain row may reference it.
 */
export function preparedContentObjectSteps(
  prepared: readonly PreparedContentObject[],
  savepointPrefix: string
): RepositoryTransactionStep[] {
  const unique = [...new Map(prepared.map((content) => [content.metadata.id, content])).values()];
  return unique.flatMap((content, index) => [
    ...(content.insert ? [savepoint(`${savepointPrefix}_${index}`, [content.insert], {
      kind: 'rollback-and-continue-on-unique',
      constraints: [
        { domain: 'ContentObject', columns: ['id'] },
        { domain: 'ContentObject', columns: ['content_type', 'sha256', 'byte_length'] }
      ]
    })] : []),
    DOMAIN_REPOSITORIES.domain('ContentObject').assert(content.metadata.id, {
      content_type: content.metadata.content_type,
      sha256: content.metadata.sha256,
      byte_length: content.metadata.byte_length,
      storage_key: content.metadata.storage_key
    })
  ]);
}
