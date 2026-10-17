import type Database from 'better-sqlite3';
import { DOMAIN_REPOSITORIES, type DomainRow } from './repositories';
import { prepareCached } from './runtimeStatementCache';
import { requireRuntimeId } from './runtimeSqlRows';
import { assistantMessageRevisionIdFor, nativeItemRevisionId } from './turnOutput';

const ACTIVE_MODEL_REQUEST_STATUSES = ['prepared', 'streaming', 'retrying'] as const;
const PAGE_SIZE = 1000;

/** Exact Turn scope; completed requests never enter decoding or Worker transport. */
export function readActiveModelRequests(database: Database.Database, turnIdInput: string): DomainRow[] {
  const turnId = requireRuntimeId(turnIdInput);
  const repository = DOMAIN_REPOSITORIES.domain('ModelRequest');
  const rows: DomainRow[] = [];
  const statement = prepareCached(database, `
    SELECT * FROM model_request INDEXED BY ix_model_request_02
     WHERE status = @status AND turn_id = @turnId
       AND (request_seq > @afterSeq OR (request_seq = @afterSeq AND id > @afterId))
     ORDER BY request_seq, id LIMIT ${PAGE_SIZE}
  `);
  for (const status of ACTIVE_MODEL_REQUEST_STATUSES) {
    let afterSeq = -1n;
    let afterId = '';
    for (;;) {
      const page = statement.all({ status, turnId, afterSeq, afterId }) as DomainRow[];
      for (const row of page) rows.push(repository.codec.decode(row));
      if (page.length < PAGE_SIZE) break;
      const last = page[page.length - 1]!;
      afterSeq = BigInt(String(last.request_seq));
      afterId = String(last.id);
    }
  }
  return rows.sort((left, right) => {
    const a = BigInt(String(left.request_seq)), b = BigInt(String(right.request_seq));
    return a < b ? -1 : a > b ? 1 : String(left.id).localeCompare(String(right.id));
  });
}

export interface ModelRequestStopCandidates {
  partialRequests: DomainRow[];
  toolOutputRequests: DomainRow[];
}

/** Metadata candidates from one read snapshot; output bodies are read only by existing settlement. */
export function readModelRequestStopCandidates(database: Database.Database, turnIdInput: string): ModelRequestStopCandidates {
  const turnId = requireRuntimeId(turnIdInput);
  const repository = DOMAIN_REPOSITORIES.domain('ModelRequest');
  const decode = (rows: DomainRow[]) => rows.map(row => repository.codec.decode(row));
  const partialCandidates = prepareCached(database, `
    SELECT request.* FROM model_request AS request
     WHERE request.turn_id = @turnId AND request.status = 'terminal'
       AND request.terminal_state NOT IN ('completed', 'native_chain_rebased')
       AND EXISTS (SELECT 1 FROM model_stream_checkpoint AS checkpoint
         WHERE checkpoint.model_request_id = request.id AND checkpoint.checkpoint_kind = 'partial_summary'
           AND checkpoint.attempt_seq = CAST(json_extract(request.stream_stats_json, '$.attemptSeq') AS INTEGER)
           AND checkpoint.socket_generation = CAST(json_extract(request.stream_stats_json, '$.socketGeneration') AS INTEGER))
     ORDER BY request.request_seq, request.id
  `).all({ turnId }) as DomainRow[];
  // Reuse the original immutable output identities: an existing partial revision is already
  // materialized. No body read or new completion marker is needed to choose the remaining work.
  const partialExists = prepareCached(database, 'SELECT 1 FROM message_revision WHERE id IN (?, ?) LIMIT 1');
  const partialRequests = partialCandidates.filter(request => !partialExists.get(
    assistantMessageRevisionIdFor(turnId, `failed-partial:${String(request.id)}`),
    nativeItemRevisionId(turnId, String(request.id), `failed-partial:failed-partial:${String(request.id)}`)
  )).map(request => repository.codec.decode(request));

  const toolOutputRequests = decode(prepareCached(database, `
    WITH missing_closure AS (
      SELECT DISTINCT source.model_request_id AS id
        FROM tool_call AS call
        JOIN tool_call_source_link AS source ON source.tool_call_id = call.id
        LEFT JOIN tool_model_result AS result ON result.tool_call_id = call.id
       WHERE call.turn_id = @turnId
         AND (result.id IS NULL
           OR NOT EXISTS (SELECT 1 FROM context_segment_source AS occurrence
             WHERE occurrence.source_kind = 'tool_model_result' AND occurrence.source_id = result.id)
           OR NOT EXISTS (SELECT 1 FROM context_segment_source AS occurrence
             WHERE occurrence.source_kind = 'tool_call' AND occurrence.source_id = call.id))
    ), latest_output AS (
      SELECT request.id FROM model_request AS request
       WHERE request.turn_id = @turnId AND request.status = 'terminal' AND request.terminal_state = 'completed'
         AND EXISTS (SELECT 1 FROM model_request_message_link AS output WHERE output.model_request_id = request.id)
       ORDER BY request.request_seq DESC LIMIT 1
    ), candidates AS (
      SELECT id FROM missing_closure
      UNION
      SELECT latest.id FROM latest_output AS latest
       WHERE NOT EXISTS (SELECT 1 FROM tool_call_source_link AS source WHERE source.model_request_id = latest.id)
    )
    SELECT request.* FROM candidates
      JOIN model_request AS request ON request.id = candidates.id
     WHERE request.turn_id = @turnId AND request.status = 'terminal' AND request.terminal_state = 'completed'
     ORDER BY request.request_seq, request.id
  `).all({ turnId }) as DomainRow[]);
  return { partialRequests, toolOutputRequests };
}
