/**
 * A WebSocket close is only replay-safe at this boundary when the Responses request has not
 * reached a terminal event (and the caller has not observed semantic output). Keep this transport
 * list shared by the session and reliable Provider adapter so close metadata cannot lose retry
 * authority while crossing the capability boundary.
 */
export const OPENAI_RESPONSES_RETRYABLE_PRE_TERMINAL_CLOSE_CODES = [
  1000, // Normal Closure before a Responses terminal event still leaves the request incomplete.
  1001, // Going Away.
  1005, // No Status Received (local sentinel; never sent on the wire).
  1006, // Abnormal Closure (TCP/proxy/network interruption without a close frame).
  1011, // Server Internal Error.
  1012, // Service Restart.
  1013, // Try Again Later.
  1014, // Bad Gateway.
  1015 // TLS Handshake failure (local sentinel; never sent on the wire).
] as const;

const RETRYABLE_PRE_TERMINAL_CLOSE_CODES = new Set<number>(
  OPENAI_RESPONSES_RETRYABLE_PRE_TERMINAL_CLOSE_CODES
);
const PRE_TERMINAL_CLOSE_PATTERN = /\b(?:openai responses )?websocket closed before (?:terminal event|response\.completed|open)\b/i;
const PRE_TERMINAL_CLOSE_CODE_PATTERN = /\b(?:openai responses )?websocket closed before (?:terminal event|response\.completed|open)(?::|\s)+(\d{4})\b/i;

export interface OpenAIResponsesPreTerminalWebSocketClose {
  closeCode?: number;
  /** Undefined only when the message has no close code and metadata did not provide one. */
  retryable?: boolean;
}

export function isRetryableOpenAIResponsesWebSocketClose(
  closeCode: number,
  closeReason = ''
): boolean {
  return RETRYABLE_PRE_TERMINAL_CLOSE_CODES.has(closeCode)
    || (closeCode === 1008
      && closeReason.toLowerCase().includes('missing first response.create message'));
}

/**
 * Recognizes only a close explicitly reported before the Responses terminal event. Unknown coded
 * closes are permanent by default; a code-less premature close may still use surrounding transport
 * metadata in the reliable Provider classifier.
 */
export function classifyOpenAIResponsesPreTerminalWebSocketClose(
  message: string,
  metadataCloseCode?: unknown
): OpenAIResponsesPreTerminalWebSocketClose | undefined {
  if (!PRE_TERMINAL_CLOSE_PATTERN.test(message)) return undefined;
  const closeCode = normalizeWebSocketCloseCode(metadataCloseCode)
    ?? closeCodeFromPreTerminalMessage(message);
  if (closeCode === undefined) return {};
  return {
    closeCode,
    retryable: isRetryableOpenAIResponsesWebSocketClose(closeCode, message)
  };
}

function closeCodeFromPreTerminalMessage(message: string): number | undefined {
  const match = PRE_TERMINAL_CLOSE_CODE_PATTERN.exec(message);
  return normalizeWebSocketCloseCode(match?.[1]);
}

function normalizeWebSocketCloseCode(value: unknown): number | undefined {
  const numeric = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d{4}$/.test(value.trim())
      ? Number(value.trim())
      : NaN;
  return Number.isInteger(numeric) && numeric >= 1000 && numeric <= 4999
    ? numeric
    : undefined;
}
