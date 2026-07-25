import type { JsonValue } from '../../shared/conversationReliability';
import type { ToolResultArtifactRecord } from '../../shared/protocol';

/** Backend-only canonical Artifact data. ClientState projects metadata/preview and never modelResponse. */
export interface DurableToolResultArtifactRecord extends ToolResultArtifactRecord {
  modelResponse: JsonValue;
}
