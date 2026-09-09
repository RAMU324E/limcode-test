import type { OpenAIResponsesSteeringCommand, OpenAIResponsesToolOutput } from '../../shared/openAIResponsesNative';

/**
 * Stable kernel-facing disposition of a rejected native controller submission. This module must
 * stay free of WebSocket implementation imports so the provider lazy-load invariant holds.
 *
 * - `not_sent`: the submission never reached the wire. Durable local state stays queued/undelivered;
 *   resubmitting on a future connection is safe.
 * - `admission_unknown`: the submission was written but the connection dropped before server
 *   admission. Reconcile from durable local facts; never re-execute tools; never auto-resend.
 * - `failed`: the server or transport state definitively refused the submission (for example a
 *   lane-scoped error such as `previous_response_not_found`). Not delivered; a full-context
 *   continuation carries the same durable items on the next chain.
 */
export type OpenAIResponsesNativeDeliveryDisposition = 'not_sent' | 'admission_unknown' | 'failed';

export interface OpenAIResponsesNativeDeliveryDetail {
  /** Local steer submission correlation, when the rejected operation was a steer. */
  submissionId?: string;
  /** Provider call IDs carried by a rejected tool-result submission. */
  callIds?: string[];
  /** Short stable machine reason, e.g. controller_released, encode_failed, connection_lost, lane_error. */
  reason?: string;
}

export class OpenAIResponsesNativeDeliveryError extends Error {
  public readonly code = 'OPENAI_RESPONSES_NATIVE_DELIVERY';

  public constructor(
    public readonly disposition: OpenAIResponsesNativeDeliveryDisposition,
    message: string,
    public readonly detail: OpenAIResponsesNativeDeliveryDetail = {}
  ) {
    super(message);
    this.name = 'OpenAIResponsesNativeDeliveryError';
  }
}

export function isOpenAIResponsesNativeDeliveryError(
  error: unknown
): error is OpenAIResponsesNativeDeliveryError {
  return error instanceof OpenAIResponsesNativeDeliveryError;
}

/**
 * Captured identity of the exact response.created that admitted a tool-result continuation.
 * Resolved at server admission so delivery attribution can never race a later response.
 */
export interface OpenAIResponsesNativeResultAdmission {
  responseId: string;
  /**
   * The previous_response_id actually wired for the admitted continuation. Absent on store=false
   * full-history transports where no predecessor is wired; never fabricated from local guesses.
   */
  previousResponseId?: string;
  /** Physical WebSocket connection generation; absent on stateless HTTP transports, never fabricated. */
  connectionGeneration?: number;
  streamId?: string;
}

/** Process-local transport capability. Never serialize this object through the Webview bridge. */
export interface OpenAIResponsesNativeController {
  readonly responseId: string | undefined;
  /** Physical WebSocket connection generation; absent on stateless HTTP transports, never fabricated. */
  readonly connectionGeneration?: number;
  readonly streamId: string | undefined;
  steer(command: OpenAIResponsesSteeringCommand): Promise<void>;
  submitToolResults(
    outputs: readonly OpenAIResponsesToolOutput[]
  ): Promise<OpenAIResponsesNativeResultAdmission>;
  /** End at a response boundary after the kernel has durably disposed of pending work. */
  endLogicalRequest(): void;
}

export interface OpenAIResponsesNativeHooks {
  onController?(controller: OpenAIResponsesNativeController | undefined): void;
  /**
   * Proven local capacity-wait signal (multiplexed lane/slot capacity or the exclusive session
   * lock). Emitted exactly on wait enter/leave, including abort cleanup; never a provider fact
   * and never synthesized for a request that has not reached the wire. Consumers may pause
   * semantic read deadlines for the wait, never the total request deadline.
   */
  onLaneQueueState?(queued: boolean): void;
}
