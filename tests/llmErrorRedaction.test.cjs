const assert = require('node:assert/strict');
const test = require('node:test');

const {
  rawErrorFromUnknown
} = require('../dist/extension/backend/capabilities/llmProvider.js');

test('Error 转成可靠内核事件时保留非秘密诊断字段', () => {
  const error = Object.assign(new Error('OpenAI Responses WebSocket closed'), {
    transport: 'websocket',
    phase: 'awaiting_first_event',
    closeCode: 1011,
    closeReason: 'upstream websocket proxy failed',
    wasClean: false,
    receivedServerEvent: false,
    attempt: 3,
    maxAttempts: 3,
    transportAttemptsExhausted: true,
    retryable: true,
    code: 'network_changed',
    statusCode: 503,
    timeoutMs: 30_000,
    requestId: 'provider-request-123',
    providerDetails: { region: 'local-dev', continuationTokenCount: 2 },
    apiKey: 'top-level-api-key-must-not-leak',
    Authorization: 'Bearer top-level-auth-must-not-leak',
    headers: { authorization: 'Bearer header-auth-must-not-leak' },
    debugContext: { customerSecret: 'arbitrary-own-property-must-not-copy' },
    cause: {
      message: 'socket closed by peer',
      api_key: 'nested-api-key-must-not-leak',
      headers: {
        Authorization: 'Bearer nested-auth-must-not-leak',
        'x-request-id': 'request-from-cause'
      }
    }
  });

  const raw = rawErrorFromUnknown(error);

  assert.equal(raw.transport, 'websocket');
  assert.equal(raw.phase, 'awaiting_first_event');
  assert.equal(raw.closeCode, 1011);
  assert.equal(raw.closeReason, 'upstream websocket proxy failed');
  assert.equal(raw.wasClean, false);
  assert.equal(raw.receivedServerEvent, false);
  assert.equal(raw.attempt, 3);
  assert.equal(raw.maxAttempts, 3);
  assert.equal(raw.transportAttemptsExhausted, true);
  assert.equal(raw.retryable, true);
  assert.equal(raw.code, 'network_changed');
  assert.equal(raw.statusCode, 503);
  assert.equal(raw.timeoutMs, 30_000);
  assert.equal(raw.requestId, 'provider-request-123');
  assert.deepEqual(raw.providerDetails, { region: 'local-dev', continuationTokenCount: 2 });
  assert.equal(raw.apiKey, undefined);
  assert.equal(raw.Authorization, undefined);
  assert.deepEqual(raw.headers, {});
  assert.deepEqual(raw.debugContext, {});
  assert.deepEqual(raw.cause, {
    message: 'socket closed by peer',
    headers: { 'x-request-id': 'request-from-cause' }
  });

  assertSecretsAbsent(raw, [
    'top-level-api-key-must-not-leak',
    'top-level-auth-must-not-leak',
    'header-auth-must-not-leak',
    'arbitrary-own-property-must-not-copy',
    'nested-api-key-must-not-leak',
    'nested-auth-must-not-leak'
  ]);
});

test('普通对象和额外响应数据也会递归去掉密钥与认证头', () => {
  const raw = rawErrorFromUnknown({
    kind: 'stream_error',
    message: 'Provider rejected request',
    status: 401,
    apiKey: 'plain-api-key-must-not-leak',
    clientSecret: 'plain-client-secret-must-not-leak',
    headers: {
      authorization: 'Bearer plain-auth-must-not-leak',
      'x-api-key': 'plain-header-api-key-must-not-leak',
      'x-request-id': 'request-from-provider'
    },
    data: {
      error: {
        code: 'invalid_api_key',
        message: 'Incorrect API key provided.'
      },
      accessToken: 'plain-access-token-must-not-leak'
    }
  }, {
    Authorization: 'Bearer extra-auth-must-not-leak',
    rawResponse: {
      headers: new Headers({
        authorization: 'Bearer response-auth-must-not-leak',
        'content-type': 'application/json',
        'set-cookie': 'session=response-cookie-must-not-leak'
      }),
      body: {
        error: { code: 'invalid_api_key' },
        password: 'response-password-must-not-leak'
      }
    }
  });

  assert.equal(raw.kind, 'stream_error');
  assert.equal(raw.message, 'Provider rejected request');
  assert.equal(raw.status, 401);
  assert.deepEqual(raw.headers, { 'x-request-id': 'request-from-provider' });
  assert.deepEqual(raw.data, {
    error: {
      code: 'invalid_api_key',
      message: 'Incorrect API key provided.'
    }
  });
  assert.deepEqual(raw.rawResponse, {
    headers: { 'content-type': 'application/json' },
    body: { error: { code: 'invalid_api_key' } }
  });
  assert.equal(raw.Authorization, undefined);

  assertSecretsAbsent(raw, [
    'plain-api-key-must-not-leak',
    'plain-client-secret-must-not-leak',
    'plain-auth-must-not-leak',
    'plain-header-api-key-must-not-leak',
    'plain-access-token-must-not-leak',
    'extra-auth-must-not-leak',
    'response-auth-must-not-leak',
    'response-cookie-must-not-leak',
    'response-password-must-not-leak'
  ]);
});

function assertSecretsAbsent(value, secrets) {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, `secret leaked: ${secret}`);
  assert.equal(/authorization/i.test(serialized), false, 'authorization field leaked');
}
