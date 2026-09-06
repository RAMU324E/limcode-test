import assert from 'node:assert/strict';
import test from 'node:test';
import { processStreamResponse, sendRequest, attachLlmResponseObserver, getLlmObservation } from 'unified-llm-provider';

const encoder = new TextEncoder();

function response(chunks, onRead = () => {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index === chunks.length) controller.close();
      else {
        onRead(index);
        controller.enqueue(encoder.encode(chunks[index++]));
      }
    }
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}

test('当前依赖只传逐块调试回调时不会调用，不能把该回调直接当记录开关', async () => {
  let calls = 0;
  const res = await sendRequest({
    url: 'https://example.invalid/responses', headers: {},
    fetch: async () => response(['data: {}\n\n', 'data: [DONE]\n\n']),
    debug: { onStreamChunk: () => { calls += 1; } }
  }, {}, true);
  await res.text();
  assert.equal(calls, 0);
});

test('当前依赖的现成调试接口每次提供累计全文，没有来源编号或字节范围', async () => {
  const chunks = ['data: {"delta":"甲"}\n\n', 'data: {"delta":"甲"}\n\n', 'data: [DONE]\n\n'];
  const seen = [];
  const res = await sendRequest({
    url: 'https://example.invalid/responses', headers: {},
    fetch: async () => response(chunks),
    debug: { onResponse: () => {}, onStreamChunk: (event) => seen.push(event) }
  }, {}, true);
  assert.equal(await res.text(), chunks.join(''));
  assert.deepEqual(seen.map((event) => event.accumulated), chunks.map((_, i) => chunks.slice(0, i + 1).join('')));
  assert.deepEqual(Object.keys(seen[0]).sort(), ['accumulated', 'chunk', 'url']);
});

test('一次读取包含两条相同消息时，实际解码输入没有可区分的来源身份', async () => {
  const raw = 'data: {"delta":"same"}\n\n';
  let reads = 0;
  const seen = [];
  const format = {
    createStreamState: () => ({}),
    decodeStreamChunk: (value) => {
      seen.push({ value, reads });
      return { textDelta: value.delta };
    }
  };
  const chunks = [];
  for await (const chunk of processStreamResponse(response([raw + raw], () => { reads += 1; }), format)) chunks.push(chunk);
  assert.deepEqual(chunks, [{ textDelta: 'same' }, { textDelta: 'same' }]);
  assert.deepEqual(seen.map((entry) => entry.reads), [1, 1]);
  assert.deepEqual(seen[0].value, seen[1].value);
  assert.notEqual(seen[0].value, seen[1].value);
  assert.deepEqual(Object.keys(seen[0].value), ['delta']);
});

test('新增观察接口以真实字节位置区分相同消息，不修改模型结果', async () => {
  const wire = 'data: {"delta":"中文"}\r\n\r\n';
  const raw = encoder.encode(wire + wire);
  const events = [];
  const observedResponse = attachLlmResponseObserver(new Response(new ReadableStream({ start(c) {
    c.enqueue(raw.slice(0, 18));
    c.enqueue(raw.slice(18, 20));
    c.enqueue(raw.slice(20));
    c.close();
  } })), {
    streamId: 'stream-a', active: () => 'capture-a',
    observe(event) { events.push(structuredClone(event)); return { index: events.length }; }
  });
  const output = [];
  const references = [];
  for await (const chunk of processStreamResponse(observedResponse, {
    createStreamState: () => ({}), decodeStreamChunk: (value) => ({ textDelta: value.delta })
  })) {
    output.push(chunk);
    references.push(getLlmObservation(chunk));
  }
  assert.deepEqual(output, [{ textDelta: '中文' }, { textDelta: '中文' }]);
  assert.notDeepEqual(references[0], references[1]);
  const parsed = events.filter(e => e.kind === 'sse_event');
  assert.deepEqual(parsed.map(e => [e.byteStart, e.byteEnd]), [[0, encoder.encode(wire).length], [encoder.encode(wire).length, raw.length]]);
  for (const e of parsed) assert.equal(new TextDecoder().decode(raw.slice(e.byteStart, e.byteEnd)), wire);
  assert.equal(events.filter(e => e.kind === 'decode_input').length, 2);
});

test('新增观察接口关闭或抛出异常时不改变输出，中途开启不伪造早期来源', async () => {
  let active = false;
  const events = [];
  const wire = 'data: {"delta":"a"}\n\n';
  const responseWithObserver = attachLlmResponseObserver(response([wire + wire]), {
    streamId: 'stream-a', active: () => active ? 'capture-a' : undefined,
    observe(event) { events.push(event); throw new Error('记录失败'); }
  });
  const output = [];
  for await (const chunk of processStreamResponse(responseWithObserver, {
    createStreamState: () => ({}), decodeStreamChunk: (value) => ({ textDelta: value.delta })
  })) {
    output.push(chunk);
    if (!active) { assert.equal(events.length, 0); active = true; }
  }
  assert.deepEqual(output, [{ textDelta: 'a' }, { textDelta: 'a' }]);
  const parsed = events.find(e => e.kind === 'sse_event');
  assert.equal(parsed.byteStart, undefined);
  assert.equal(parsed.byteEnd, encoder.encode(wire + wire).length);
});
