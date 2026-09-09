import assert from 'node:assert/strict';
import test from 'node:test';
import { projectReliableConversation } from '../src/domain/reliableConversationProjection.ts';
import { modelRequestNativeCapabilities } from '../src/reliability/modelRequestStreamStats.ts';

const ready = (text: string) => ({ status: 'ready' as const, text, totalBytes: text.length });

const ITEM_ONE = { text: 'item one', outputItem: { id: 'item-1', ordinal: 1, providerResponseId: 'resp-1' } };
const ITEM_TWO = { text: 'item two done', outputItem: { id: 'item-2', ordinal: 2, providerResponseId: 'resp-1' } };
const ITEM_LIVE = { text: 'live tail', outputItem: { id: 'item-3', ordinal: 3, providerResponseId: 'resp-1' } };

function nativeShellRecords(requestStatus: string) {
  return {
    Turn: {
      'turn-a': {
        id: 'turn-a', conversation_id: 'conversation-a', status: 'active',
        created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:01.000Z'
      }
    },
    Message: {
      'message-a': {
        id: 'message-a', conversation_id: 'conversation-a', message_seq: '1', revision_id: 'revision-a',
        role: 'model', created_at: '2026-08-03T00:00:02.000Z'
      }
    },
    MessageTurnLink: {
      'link-a': { id: 'link-a', message_id: 'message-a', turn_id: 'turn-a', role: 'model' }
    },
    ModelRequest: {
      'request-a': {
        id: 'request-a', turn_id: 'turn-a', request_seq: '1', model_id: 'gpt-6-astra',
        status: requestStatus, created_at: '2026-08-03T00:00:01.000Z'
      }
    },
    ModelRequestMessageLink: {
      'request-message-a': { id: 'request-message-a', model_request_id: 'request-a', message_id: 'message-a' }
    }
  };
}

function nativeTransient(outputParts: unknown[]) {
  return {
    'request-a': {
      conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request-a',
      requestSeq: '1', providerId: 'provider-a', modelId: 'gpt-6-astra', streamSeq: '3',
      text: '', thought: '',
      outputParts,
      toolCalls: [],
      status: 'streaming' as const, startedAt: 1_000, updatedAt: 2_000
    }
  };
}

test('native early immutable revision keeps live transient text and dedupes completed items', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: nativeShellRecords('streaming'),
    details: {
      // 当前 Revision 已推进到最新完成 item（只有 item-2），请求仍在流式。
      'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [ITEM_TWO] }))
    },
    transientModelRequests: nativeTransient([ITEM_ONE, ITEM_TWO, ITEM_LIVE])
  });
  assert.equal(projection.messages.length, 1);
  assert.equal(projection.messages[0]?.id, 'message-a');
  assert.equal(projection.messages[0]?.status, 'streaming');
  assert.deepEqual(
    projection.messages[0]?.content.parts,
    [ITEM_ONE, ITEM_TWO, ITEM_LIVE],
    '已完成 item 不得重复，进行中的实时文本不得被提前到达的不可变 Revision 丢弃'
  );
});

test('native early revision inserts items the transient missed at their chronological position', () => {
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records: nativeShellRecords('streaming'),
    details: {
      'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [ITEM_TWO] }))
    },
    // 恢复间隙：瞬态只有 item-1 和在飞的 item-3，缺 item-2。
    transientModelRequests: nativeTransient([ITEM_ONE, ITEM_LIVE])
  });
  assert.deepEqual(
    projection.messages[0]?.content.parts,
    [ITEM_ONE, ITEM_TWO, ITEM_LIVE],
    '瞬态缺失的 durable item 必须按 outputItem.ordinal 插回，而不是追加到尾部或丢弃'
  );
});

test('terminal aggregate revision still supersedes the transient on the native path', () => {
  const records = nativeShellRecords('terminal');
  (records.ModelRequest['request-a'] as Record<string, unknown>).terminal_state = 'completed';
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details: {
      'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: [ITEM_ONE, ITEM_TWO] }))
    },
    transientModelRequests: nativeTransient([ITEM_ONE, ITEM_TWO, ITEM_LIVE])
  });
  assert.equal(projection.messages.length, 1);
  assert.deepEqual(
    projection.messages[0]?.content.parts,
    [ITEM_ONE, ITEM_TWO],
    '请求终结后最终聚合 Revision 是唯一展示权威'
  );
});

function steeringChainRecords() {
  const aggregateParts = [
    ITEM_ONE,
    { text: 'successor answer', outputItem: { id: 'item-9', ordinal: 1, providerResponseId: 'resp-2', previousResponseId: 'resp-1' } },
    {
      id: 'provider-call-succ',
      functionCall: { name: 'read', args: { path: 'a.ts' } },
      outputItem: { id: 'item-10', ordinal: 2, providerResponseId: 'resp-2', previousResponseId: 'resp-1' }
    }
  ];
  return {
    records: {
      Turn: {
        'turn-a': {
          id: 'turn-a', conversation_id: 'conversation-a', status: 'active',
          created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:05.000Z'
        }
      },
      Message: {
        'message-a': {
          id: 'message-a', conversation_id: 'conversation-a', message_seq: '1', revision_id: 'revision-a',
          role: 'model', created_at: '2026-08-03T00:00:02.000Z'
        },
        'message-steer': {
          id: 'message-steer', conversation_id: 'conversation-a', message_seq: '2', revision_id: 'revision-steer',
          role: 'user', created_at: '2026-08-03T00:00:03.000Z'
        }
      },
      MessageTurnLink: {
        'link-a': { id: 'link-a', message_id: 'message-a', turn_id: 'turn-a', role: 'model' },
        'link-steer': { id: 'link-steer', message_id: 'message-steer', turn_id: 'turn-a', role: 'native_steer' }
      },
      ModelRequest: {
        'request-a': {
          id: 'request-a', turn_id: 'turn-a', request_seq: '1', model_id: 'gpt-6-astra',
          status: 'terminal', terminal_state: 'completed', created_at: '2026-08-03T00:00:01.000Z'
        }
      },
      ModelRequestMessageLink: {
        'request-message-a': { id: 'request-message-a', model_request_id: 'request-a', message_id: 'message-a' }
      },
      ToolCall: {
        'call-a': {
          id: 'call-a', turn_id: 'turn-a', tool_name: 'read', status: 'terminal', call_seq: '1',
          created_at: '2026-08-03T00:00:04.000Z', updated_at: '2026-08-03T00:00:05.000Z'
        }
      },
      ToolCallSourceLink: {
        'source-a': {
          id: 'source-a', tool_call_id: 'call-a', message_id: 'message-a',
          provider_call_id: 'provider-call-succ', provider_ordinal: '1'
        }
      }
    },
    details: {
      'message-content:revision-a': ready(JSON.stringify({ role: 'model', parts: aggregateParts })),
      'message-content:revision-steer': ready(JSON.stringify({ role: 'user', parts: [{ text: '换个方向' }] })),
      'tool-arguments-content:call-a': ready('{"path":"a.ts"}'),
      'tool-result-content:call-a': ready('{"output":"ok"}')
    }
  };
}

const STEER_RECEIPT = {
  submissionId: 'submission-1',
  conversationId: 'conversation-a',
  turnId: 'turn-a',
  modelRequestId: 'request-a',
  state: 'continuing' as const,
  messageId: 'message-steer',
  targetResponseId: 'resp-1',
  successorResponseId: 'resp-2',
  updatedAt: 4_000
};

test('steering boundary splits the aggregate so successor output renders after the user instruction', () => {
  const { records, details } = steeringChainRecords();
  const projection = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details,
    steeringReceipts: [STEER_RECEIPT]
  });
  assert.deepEqual(
    projection.messages.map((message) => message.id),
    ['message-a', 'message-steer', 'message-a:steer-successor:resp-2'],
    '初始响应、转向指令、后继响应必须按真实时序排列'
  );
  const [initial, steer, successor] = projection.messages;
  assert.deepEqual(initial?.content.parts, [ITEM_ONE]);
  assert.equal(steer?.role, 'user');
  assert.equal(successor?.content.parts.length, 2);
  assert.ok((successor?.seq ?? 0) > (steer?.seq ?? 0), '后继输出不得渲染在用户转向指令之上');
  const call = projection.toolCalls.find((candidate) => candidate.id === 'call-a');
  assert.equal(call?.messageId, 'message-a:steer-successor:resp-2',
    'ToolCallSourceLink 指向聚合消息时，durable 调用必须解析到部件实际所在的拆分条目');
  assert.equal(
    projection.toolCallsByMessageId['message-a:steer-successor:resp-2']?.[0]?.id,
    'call-a'
  );
  assert.equal(
    projection.splitSourceMessageIdByMessageId['message-a:steer-successor:resp-2'],
    'message-a',
    '拆分条目必须暴露来源映射供预览与详请回溯'
  );
});

test('aggregate without an authoritative receipt keeps full content instead of guessing pairings', () => {
  const { records, details } = steeringChainRecords();
  const withoutReceipts = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details,
    steeringReceipts: []
  });
  assert.equal(withoutReceipts.messages.filter((message) => message.role === 'model').length, 1);
  assert.equal(withoutReceipts.messages[0]?.content.parts.length, 3);

  const wrongRequest = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details,
    steeringReceipts: [{ ...STEER_RECEIPT, modelRequestId: 'request-other' }]
  });
  assert.equal(wrongRequest.messages.filter((message) => message.role === 'model').length, 1,
    '指向其它 ModelRequest 的回执不得驱动拆分');

  const wrongSuccessor = projectReliableConversation({
    conversationId: 'conversation-a',
    records,
    details,
    steeringReceipts: [{ ...STEER_RECEIPT, successorResponseId: 'resp-9' }]
  });
  assert.equal(wrongSuccessor.messages.filter((message) => message.role === 'model').length, 1,
    'successorResponseId 与聚合内容不匹配时保留完整内容');
});

test('unstamped aggregate content is never split', () => {
  const { records, details } = steeringChainRecords();
  details['message-content:revision-a'] = ready(JSON.stringify({
    role: 'model',
    parts: [{ text: 'plain answer one' }, { text: 'plain answer two' }]
  }));
  const projection = projectReliableConversation({ conversationId: 'conversation-a', records, details });
  assert.equal(projection.messages.filter((message) => message.role === 'model').length, 1);
});

test('native async continuation renders despite an unsettled earlier call; legacy path stays suppressed', () => {
  const baseRecords = (streamStatsJson?: unknown) => ({
    Turn: {
      'turn-a': {
        id: 'turn-a', conversation_id: 'conversation-a', status: 'active',
        created_at: '2026-08-03T00:00:00.000Z', updated_at: '2026-08-03T00:00:03.000Z'
      }
    },
    Message: {
      'message-user': {
        id: 'message-user', conversation_id: 'conversation-a', message_seq: '1', revision_id: 'revision-user',
        role: 'user', created_at: '2026-08-03T00:00:00.500Z'
      }
    },
    ToolCall: {
      'call-old': {
        id: 'call-old', turn_id: 'turn-a', tool_name: 'write', status: 'executing', call_seq: '1',
        created_at: '2026-08-03T00:00:01.000Z', updated_at: '2026-08-03T00:00:02.000Z'
      }
    },
    ModelRequest: {
      'request-b': {
        id: 'request-b', turn_id: 'turn-a', request_seq: '2', model_id: 'gpt-6-astra',
        status: 'streaming', created_at: '2026-08-03T00:00:02.000Z',
        ...(streamStatsJson ? { stream_stats_json: streamStatsJson } : {})
      }
    }
  });
  const details = {
    'message-content:revision-user': ready(JSON.stringify({ role: 'user', parts: [{ text: '开始' }] }))
  };
  const transientModelRequests = {
    'request-b': {
      conversationId: 'conversation-a', turnId: 'turn-a', modelRequestId: 'request-b',
      requestSeq: '2', providerId: 'provider-a', modelId: 'gpt-6-astra', streamSeq: '2',
      text: '', thought: '',
      outputParts: [ITEM_ONE],
      toolCalls: [],
      status: 'streaming' as const, startedAt: 2_000, updatedAt: 3_000
    }
  };

  const legacy = projectReliableConversation({
    conversationId: 'conversation-a',
    records: baseRecords(),
    details,
    transientModelRequests
  });
  assert.deepEqual(
    legacy.messages.map((message) => message.id),
    ['message-user'],
    '非原生路径：前序调用未终结时新的瞬态输出仍被抑制（旧行为不变）'
  );

  const native = projectReliableConversation({
    conversationId: 'conversation-a',
    records: baseRecords({
      nativeCapabilities: {
        asyncTools: true, steering: false, reasoningUpdates: false, multiplexing: false, explicitCaching: true
      }
    }),
    details,
    transientModelRequests
  });
  assert.deepEqual(
    native.messages.map((message) => message.id),
    ['message-user', 'transient:request-b'],
    '原生异步链上，已授权的续流输出不得被前序未决异步调用隐藏'
  );
});

test('modelRequestNativeCapabilities reads the frozen projection exactly and fails closed', () => {
  const fromObject = modelRequestNativeCapabilities({
    stream_stats_json: {
      nativeCapabilities: {
        asyncTools: true, steering: true, reasoningUpdates: false, multiplexing: false, explicitCaching: true
      }
    }
  });
  assert.deepEqual(fromObject, {
    asyncTools: true, steering: true, reasoningUpdates: false, multiplexing: false, explicitCaching: true
  });
  const fromString = modelRequestNativeCapabilities({
    stream_stats_json: JSON.stringify({ nativeCapabilities: { steering: true } })
  });
  assert.equal(fromString?.steering, true);
  assert.equal(fromString?.asyncTools, false, '缺失旗标按不可用处理');
  assert.equal(modelRequestNativeCapabilities({ stream_stats_json: '{}' }), undefined);
  assert.equal(modelRequestNativeCapabilities({ stream_stats_json: 'not json' }), undefined);
  assert.equal(modelRequestNativeCapabilities({}), undefined);
  assert.equal(modelRequestNativeCapabilities(undefined), undefined);
  const invalidFlags = modelRequestNativeCapabilities({
    stream_stats_json: { nativeCapabilities: { steering: 'yes' } }
  });
  assert.equal(invalidFlags?.steering, false, '非布尔旗标必须按不可用处理，不得宽松解释为真');
});
