import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import * as kernel from '../../dist/extension/backend/reliableKernel/index.js';

const MESSAGE_TYPE = 'application/vnd.limcode.message+json';
const TOOL_PAIR_TYPE = 'application/vnd.limcode.context-tool-pair+json';
const COMPRESSION_TYPE = 'application/vnd.limcode.compression-contents+json';

function segment(segmentKind, contentType, content, messageRole = null) {
  return {
    segmentKind,
    messageRole,
    contentObject: { content_type: contentType },
    content: Buffer.from(content, 'utf8')
  };
}

function emptyBreakdown(overrides = {}) {
  const value = {
    systemTokens: 0,
    toolSchemaTokens: 0,
    providerFramingTokens: 0,
    contextTokens: 0,
    currentInputTokens: 0,
    runtimeDeliveryTokens: 0,
    turnReminderTokens: 0,
    mediaTokens: 0,
    fixedTokens: 0,
    bodyTokens: 0,
    fullTokens: 0,
    ...overrides
  };
  value.fullTokens = value.fixedTokens + value.bodyTokens;
  return value;
}

test('Agent loop只用启发式预算规划压缩且不再形成普通发送门禁', () => {
  const source = fs.readFileSync('backend/reliableKernel/agentLoop.ts', 'utf8');
  const planningStart = source.indexOf(
    'let planningBudget = this.modelProvider.planFullRequest(preview, previewAdapter);'
  );
  const compressionStart = source.indexOf('this.compressionCoordinator.coordinate({', planningStart);
  const requestCreate = source.indexOf('this.modelProvider.createModelRequest({', compressionStart);
  assert.ok(planningStart >= 0 && compressionStart > planningStart && requestCreate > compressionStart);

  const admission = source.slice(planningStart, requestCreate);
  assert.match(admission, /this\.compressionCoordinator\.coordinate\(\{/);
  assert.match(admission, /if \(compression\.status === 'compressed'\)/);
  assert.doesNotMatch(admission, /canSend|request_still_too_large|safe limit/);

  const coordinator = fs.readFileSync('backend/reliableKernel/contextCompressionCoordinator.ts', 'utf8');
  assert.match(
    coordinator,
    /const decision = await this\.compression\.evaluate\(headRootId, authoritySnapshotId\);\s*if \(trigger === 'auto' && !decision\.shouldCompress\)/,
    '自动压缩必须由Provider实测校准后的配置阈值判断准入'
  );
  assert.ok(
    coordinator.indexOf("if (trigger === 'auto' && !decision.shouldCompress)")
      < coordinator.indexOf('requestBudget.fixedTokens > requestBudget.planningInputCapacityTokens'),
    '低于Provider实测阈值的普通请求必须在启发式压缩容量检查前跳过'
  );
});

test('上下文状态通过独立projection/head关系识别上一轮精确值已过期', () => {
  const source = fs.readFileSync('webview/src/components/conversation/ReliableContextStatus.vue', 'utf8');
  assert.match(source, /records\.ModelContextProjection/);
  assert.match(source, /projection\.owner_kind === 'model_request'/);
  assert.match(source, /requestRootId !== currentRootId/);
  assert.match(
    source,
    /exactContextTokens\.value \?\? estimatedContextTokens\.value \?\? previousExactContextTokens\.value/,
    '当前root估算必须优先于已过期的Provider精确输入'
  );
  assert.match(source, /最近请求精确输入/);
  assert.doesNotMatch(source, /latestCompressionChange/);
});

test('provider语义估算不会把base64图片字符当普通文本token', () => {
  const first = 'A'.repeat(339_032);
  const second = 'B'.repeat(392_052);
  const message = {
    role: 'user',
    parts: [
      { inlineData: { mimeType: 'image/png', data: first } },
      { inlineData: { mimeType: 'image/png', data: second } }
    ]
  };
  const serialized = JSON.stringify(message);
  const estimated = kernel.estimateContextSegmentTokens(
    segment('message', MESSAGE_TYPE, serialized, 'user')
  );
  assert.ok(Buffer.byteLength(serialized) / 4 > 180_000, 'legacy byte estimate must reproduce the false 100k+ spike');
  assert.ok(estimated > 0 && estimated < 2_000, `multimodal estimate should stay bounded, got ${estimated}`);
});

test('普通模型窗口只保留同一托管附件的首次正文并在工具响应内保留F引用', () => {
  const attachment = {
    attachmentId: 'attachment-repeat-media',
    mimeType: 'image/png',
    name: 'repeat.png',
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
    data: 'Zg=='
  };
  const inlinePart = () => ({ inlineData: { ...attachment } });
  const contents = [
    { role: 'user', parts: [inlinePart()] },
    { role: 'model', parts: [{ id: 'call-repeat', functionCall: { name: 'read', args: {} } }] },
    {
      role: 'user',
      parts: [{
        id: 'call-repeat',
        functionResponse: {
          name: 'read',
          response: { ok: true },
          parts: [inlinePart()]
        }
      }]
    },
    { role: 'user', parts: [inlinePart()] }
  ];
  const handles = {
    entries: [{
      kind: 'attachment',
      ref: 'F7',
      target: attachment.attachmentId,
      name: attachment.name,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes
    }]
  };

  const projected = kernel.projectOrdinaryModelWindow(contents, handles);
  assert.equal(projected.uniqueManagedMediaBodyCount, 1);
  assert.equal(projected.suppressedManagedMediaBodyCount, 2);
  assert.equal(projected.contents.flatMap((content) => content.parts)
    .filter((part) => 'inlineData' in part).length, 1);
  const response = projected.contents[2].parts[0].functionResponse;
  assert.equal(response.parts, undefined);
  assert.deepEqual(response.response.repeatedManagedMedia.map((entry) => entry.attachmentRef), ['F7']);
  const repeatedText = projected.contents[3].parts[0].text;
  assert.match(repeatedText, /repeated_managed_media_body_omitted/);
  assert.match(repeatedText, /F7/);
  assert.doesNotMatch(repeatedText, /attachment-repeat-media|sha256|data/);
  assert.throws(
    () => kernel.projectOrdinaryModelWindow([
      { role: 'user', parts: [inlinePart()] },
      { role: 'user', parts: [{ inlineData: { ...attachment, name: 'drift.png' } }] }
    ], handles),
    /metadata changed/
  );
});

test('provider compaction ciphertext只保留rawItem权威副本且不按密文字符收费', () => {
  const ciphertext = 'cipher'.repeat(20_000);
  const contents = [{
    role: 'model',
    parts: [{
      providerContext: {
        provider: 'openai',
        format: 'openai-responses',
        itemType: 'compaction',
        encryptedContent: ciphertext,
        rawItem: { type: 'compaction', encrypted_content: ciphertext }
      }
    }]
  }];
  const canonical = kernel.canonicalizeCompressionContents(contents);
  assert.equal(canonical[0].parts[0].providerContext.encryptedContent, undefined);
  assert.equal(canonical[0].parts[0].providerContext.rawItem.encrypted_content, ciphertext);
  assert.ok(kernel.estimateMessageContentsTokens(contents) < 20);
});

test('tool_pair只估算实际重传的functionResponse，不重复计算历史工具参数', () => {
  const hugeArguments = JSON.stringify({ content: 'x'.repeat(500_000) });
  const pair = JSON.stringify({
    kind: 'tool_pair',
    toolCall: {
      id: 'call-one',
      toolName: 'read',
      argumentsContentType: 'application/json',
      arguments: hugeArguments
    },
    toolModelResult: {
      id: 'result-one',
      messageRevisionId: 'revision-one',
      resultContentType: 'application/json',
      result: JSON.stringify({ ok: true, text: 'tiny result' })
    }
  });
  const estimated = kernel.estimateContextSegmentTokens(segment('tool_pair', TOOL_PAIR_TYPE, pair));
  assert.ok(Buffer.byteLength(pair) / 4 > 100_000);
  assert.ok(estimated < 100, `tool response estimate should exclude stored arguments, got ${estimated}`);
});

test('大批搜索结果按模型投影计量，不会把约250K请求误判为452K并提前压缩', () => {
  const calls = ['advanced', 'search-a', 'search-b', 'search-c'].map((name) => ({
    id: `call-${name}`,
    functionCall: { name: `exa_${name}`, args: { query: name } }
  }));
  const segments = [
    segment('message', MESSAGE_TYPE, JSON.stringify({
      role: 'user', parts: [{ text: 'existing projected history' }]
    }), 'user'),
    segment('message', MESSAGE_TYPE, JSON.stringify({ role: 'model', parts: calls }), 'model'),
    ...calls.map((call, index) => segment('tool_pair', TOOL_PAIR_TYPE, JSON.stringify({
      kind: 'tool_pair',
      toolCall: {
        id: call.id,
        providerCallId: call.id,
        toolName: call.functionCall.name,
        argumentsContentType: 'application/json',
        arguments: JSON.stringify(call.functionCall.args)
      },
      toolModelResult: {
        id: `result-${index}`,
        resultContentType: 'application/json',
        result: JSON.stringify({ ok: true, detail: { operations: 'x'.repeat(400_000 - index * 20_000) } })
      }
    })))
  ];
  const covered = kernel.estimateMaterializedContextTokens(segments.slice(0, 2));
  const current = kernel.estimateMaterializedContextTokens(segments);
  const projectedDelta = current - covered;
  const rawToolTokens = segments.slice(2).reduce((total, item) =>
    total + kernel.estimateContextSegmentTokens(item), 0);

  assert.ok(rawToolTokens > 200_000, `fixture must reproduce the raw-result spike, got ${rawToolTokens}`);
  assert.ok(projectedDelta > 0 && projectedDelta <= kernel.TOOL_RESULT_BATCH_MAX_TOKENS + 128,
    `same-batch tool results must use the 16K model projection plus bounded envelope framing, got ${projectedDelta}`);

  const projectedFullInput = 236_285 + projectedDelta;
  const below = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 353_000,
    maxOutputTokens: 16_000,
    compressionThresholdTokens: 334_000,
    breakdown: emptyBreakdown({ bodyTokens: projectedFullInput })
  });
  assert.equal(below.planningInputCapacityTokens, 337_000);
  assert.ok(below.estimatedFullInputTokens < below.compressionThresholdTokens);
  assert.equal('canSend' in below, false);
  assert.equal('estimatedInputLimitTokens' in below, false);

  const reproduced = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 353_000,
    maxOutputTokens: 16_000,
    compressionThresholdTokens: 334_000,
    breakdown: emptyBreakdown({ fixedTokens: 17_352, bodyTokens: 314_577 })
  });
  assert.equal(reproduced.estimatedFullInputTokens, 331_929);
  assert.equal(reproduced.planningInputCapacityTokens, 337_000);
  assert.ok(260_688 < reproduced.compressionThresholdTokens,
    'Provider实测锚定的当前估算仍低于配置压缩阈值');

  const configured = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 353_000,
    maxOutputTokens: 16_000,
    compressionThresholdTokens: 300_000,
    breakdown: emptyBreakdown({ bodyTokens: 300_000 })
  });
  assert.ok(configured.estimatedFullInputTokens >= configured.compressionThresholdTokens);
});

test('压缩envelope使用provider输出token估算而非其持久化JSON大小', () => {
  const envelope = JSON.stringify({
    kind: 'compression_contents',
    version: 1,
    estimatedTokens: 3_320,
    contents: [{
      role: 'user',
      parts: [{ inlineData: { mimeType: 'image/png', data: 'A'.repeat(700_000) } }]
    }]
  });
  const estimated = kernel.estimateContextSegmentTokens(segment('compression', COMPRESSION_TYPE, envelope));
  assert.equal(estimated, 3_320);
  assert.ok(Buffer.byteLength(envelope) / 4 > 170_000);
});

test('provider usage上下文口径优先prompt/input，而不是input+output total', () => {
  const usage = { promptTokenCount: 47_100, candidatesTokenCount: 900, totalTokenCount: 48_000 };
  assert.equal(kernel.providerPromptTokens(usage), 47_100);
  assert.equal(kernel.providerTotalTokens(usage), 48_000);
  assert.equal(kernel.compressionOutputTokens(usage), 900);
});

test('实用版压缩规划使用48K主体、8K摘要和16K输出且没有全局估算硬门槛', () => {
  assert.equal(kernel.MODEL_BODY_TARGET_TOKENS, 48_000);
  assert.equal(kernel.SUMMARY_TARGET_TOKENS, 8_000);
  assert.equal(kernel.DEFAULT_OUTPUT_RESERVE_TOKENS, 16_000);
  assert.equal(kernel.ESTIMATOR_SLACK_TOKENS, undefined);
  assert.equal(kernel.TOOL_RESULT_MAX_TOKENS, 4_000);
  assert.equal(kernel.TOOL_RESULT_BATCH_MAX_TOKENS, 16_000);
  assert.equal(kernel.calculateEffectiveSummaryMaxTokens(undefined, 48_000), 8_000);
  assert.equal(kernel.calculateEffectiveSummaryMaxTokens(12_000, 48_000), 8_000);
  assert.equal(kernel.calculateEffectiveSummaryMaxTokens(8_000, 3_000), 3_000);

  const projected = kernel.estimateProjectedModelInput({
    systemInstruction: 'system instruction',
    systemPromptPrefix: 'prefix',
    tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    contextContents: [{ role: 'user', parts: [{ text: 'history' }] }],
    currentInputContents: [{ role: 'user', parts: [{ text: 'current request' }] }],
    runtimeDeliveryContents: [{ role: 'user', parts: [{ text: 'process completed' }] }],
    turnReminderContents: [{ role: 'user', parts: [{ text: 'one open task' }] }],
    providerFramingTokens: 17
  });
  const budget = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 200_000,
    providerInputLimitTokens: 100_000,
    maxOutputTokens: 2_000,
    compressionThresholdTokens: 150_000,
    breakdown: projected
  });
  assert.equal(projected.fullTokens, projected.fixedTokens + projected.bodyTokens);
  assert.equal(budget.outputReserveTokens, 16_000);
  assert.equal(budget.planningInputCapacityTokens, 100_000);
  assert.equal(budget.effectiveBodyTargetTokens, 48_000);
  assert.equal('canSend' in budget, false);
});

test('压缩请求preflight区分固定开销、完整压缩输入和fixedOverPolicy', () => {
  const fixed = kernel.preflightCompressionRequest({
    contextWindowTokens: 40_000,
    compressionThresholdTokens: 30_000,
    breakdown: emptyBreakdown({ fixedTokens: 25_000 })
  });
  assert.equal(fixed.status, 'error');
  assert.equal(fixed.code, 'fixed_overhead_infeasible');

  const body = kernel.preflightCompressionRequest({
    contextWindowTokens: 100_000,
    compressionThresholdTokens: 90_000,
    breakdown: emptyBreakdown({ fixedTokens: 1_000, bodyTokens: 84_000 })
  });
  assert.equal(body.status, 'error');
  assert.equal(body.code, 'compression_request_too_large');

  const fixedOverPolicy = kernel.calculateFullRequestPlanningBudget({
    contextWindowTokens: 200_000,
    compressionThresholdTokens: 40_000,
    breakdown: emptyBreakdown({ fixedTokens: 45_000, bodyTokens: 1_000 })
  });
  assert.equal(fixedOverPolicy.fixedOverPolicy, true);
  assert.equal(fixedOverPolicy.policyBodyRoomTokens, 0);
  assert.equal(fixedOverPolicy.effectiveBodyTargetTokens, 48_000);
});

test('工具调用和同批全部结果原子分组，文字tail不跳过中间大组', () => {
  const contents = [
    { role: 'user', parts: [{ text: 'old request '.repeat(100) }] },
    {
      role: 'model',
      parts: [
        { id: 'call-a', functionCall: { name: 'read', args: { path: '/a' } } },
        { id: 'call-b', functionCall: { name: 'search', args: { query: 'needle' } } }
      ]
    },
    { role: 'user', parts: [{ id: 'call-a', functionResponse: { name: 'read', response: { text: 'a'.repeat(20_000) } } }] },
    { role: 'user', parts: [{ id: 'call-b', functionResponse: { name: 'search', response: { text: 'b'.repeat(20_000) } } }] },
    { role: 'user', parts: [{ text: 'newest request' }] }
  ];
  const groups = kernel.groupAtomicMessageContents(contents);
  assert.equal(groups.length, 3);
  assert.equal(groups[1].kind, 'tool_exchange');
  assert.equal(groups[1].items.length, 3);
  assert.equal(groups[1].functionCallCount, 2);
  assert.equal(groups[1].functionResponseCount, 2);
  const plan = kernel.selectContinuousAtomicTail(groups, groups.at(-1).estimatedTokens);
  assert.equal(plan.tailItems.length, 1);
  assert.equal(plan.prefixGroups.at(-1).kind, 'tool_exchange');
  assert.equal(kernel.selectContinuousAtomicTail(groups, 1).protectedTailOverTarget, true);
});

test('Reliable Context信封解码后同批结果共用16K且原CAS派生对象不变', () => {
  const stored = [{
    segmentKind: 'message',
    messageRole: 'model',
    contentType: MESSAGE_TYPE,
    content: JSON.stringify({
      role: 'model',
      parts: [
        { id: 'call-a', functionCall: { name: 'read', args: { path: '/a' } } },
        { id: 'call-b', functionCall: { name: 'read', args: { path: '/b' } } }
      ]
    })
  }, ...['a', 'b'].map((name) => ({
    segmentKind: 'tool_pair',
    messageRole: null,
    contentType: TOOL_PAIR_TYPE,
    content: JSON.stringify({
      kind: 'tool_pair',
      toolCall: { id: `tool-${name}`, providerCallId: `call-${name}`, toolName: 'read' },
      toolModelResult: { id: `result-${name}`, result: JSON.stringify({ text: name.repeat(100_000) }) }
    })
  }))];
  const projectedStored = kernel.projectStoredModelFacingWindow(stored);
  assert.equal(projectedStored.contents.length, 3);
  assert.equal(projectedStored.toolResultBatches.length, 1);
  assert.ok(projectedStored.toolResultBatches[0].projectedTokens <= 16_000);

  const source = [
    { toolName: 'read', callId: 'a', resultId: 'ra', response: { path: '/a', text: 'BEGIN-A' + 'a'.repeat(80_000) + 'END-A' } },
    { toolName: 'shell', callId: 'b', resultId: 'rb', response: { processRef: 'P1', exitCode: 1, text: 'BEGIN-B' + 'b'.repeat(80_000) + 'END-B' }, priority: 'error_or_receipt', reread: { kind: 'process_output', processRef: 'P1' } },
    { toolName: 'tiny', callId: 'c', resultId: 'rc', response: { ok: true, value: 7 } }
  ];
  const before = structuredClone(source);
  const first = kernel.projectToolResultBatch(source);
  assert.deepEqual(source, before);
  assert.deepEqual(first, kernel.projectToolResultBatch(source));
  assert.equal(first.items.length, source.length);
  assert.equal(first.items[2].truncated, false);
  assert.deepEqual(first.items[2].response, source[2].response);
  assert.ok(first.projectedTokens <= 16_000);
  assert.equal(first.items[1].response.processRef, 'P1');
  assert.equal(first.items[1].response.rereadHint.processRef, 'P1');
  assert.match(first.items[1].response.preview, /BEGIN-B/);
  assert.match(first.items[1].response.preview, /END-B/);
});

test('water-fill使用priority且必要骨架软超时不丢配对身份', () => {
  const response = { text: 'same-long-evidence-'.repeat(20_000) };
  const priority = kernel.projectToolResultBatch([
    { toolName: 'search', callId: 'ordinary', response, priority: 'ordinary' },
    { toolName: 'shell', callId: 'failure', response, priority: 'error_or_receipt' }
  ], { perResultTokens: 4_000, batchTokens: 2_000 });
  assert.ok(priority.items[1].allocatedTokens > priority.items[0].allocatedTokens);
  assert.ok(priority.items[1].projectedTokens > priority.items[0].projectedTokens);

  const shortFirst = kernel.projectToolResultBatch([
    { toolName: 'short', callId: 'short', response: { text: 'small-result-'.repeat(30) } },
    { toolName: 'long-a', callId: 'long-a', response },
    { toolName: 'long-b', callId: 'long-b', response }
  ], { perResultTokens: 1_000, batchTokens: 1_000 });
  assert.equal(shortFirst.items[0].truncated, false, 'naturally short result must be satisfied before long previews');

  const source = Array.from({ length: 12 }, (_, index) => ({
    toolName: 'tool',
    callId: `call-${index}-${'x'.repeat(80)}`,
    resultId: `result-${index}`,
    response: { status: 'completed', text: 'z'.repeat(10_000) }
  }));
  const skeletons = kernel.projectToolResultBatch(source, { perResultTokens: 100, batchTokens: 100 });
  assert.equal(skeletons.mandatoryBatchOverTarget, true);
  assert.deepEqual(skeletons.items.map((item) => item.resultId), source.map((item) => item.resultId));
});

test('摘要投影移除历史媒体字节并把长工具参数改为digest描述', () => {
  const base64 = Buffer.from('SECRET-MEDIA-CONTENT'.repeat(2_000)).toString('base64');
  const projected = kernel.projectSummaryModelWindow([
    { role: 'model', parts: [{ id: 'call-write', functionCall: { name: 'write', args: { path: '/tmp/a', content: 'x'.repeat(80_000) } } }] },
    { role: 'user', parts: [{
      id: 'call-write',
      functionResponse: {
        name: 'write',
        response: { ok: true },
        parts: [{ inlineData: { mimeType: 'image/png', name: 'evidence.png', data: base64 } }]
      }
    }] }
  ]);
  const encoded = JSON.stringify(projected.contents);
  assert.equal(encoded.includes(base64), false);
  assert.equal(projected.mediaTokens, 0);
  assert.equal(projected.contents.some((content) => content.parts.some((part) => 'functionCall' in part)), false);
  assert.equal(projected.contents.some((content) => content.parts.some((part) => 'inlineData' in part)), false);
  assert.match(encoded, /sha256/);
  assert.match(encoded, /historical_media/);
});

test('native compact使用完整窗口且拒绝未固化sourcePath媒体', () => {
  const contents = [
    { role: 'user', parts: [{ text: 'first' }] },
    { role: 'model', parts: [{ text: 'second' }] },
    { role: 'user', parts: [{ text: 'third' }] }
  ];
  const ready = kernel.planNativeCompactWindow({ contents, inputCapacityTokens: 100_000 });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.contents.length, contents.length);
  assert.equal(ready.retainedLocalTailCount, 0);
  const oversized = kernel.planNativeCompactWindow({
    contents: [{ role: 'user', parts: [{ text: 'large '.repeat(10_000) }] }],
    inputCapacityTokens: 10
  });
  assert.equal(oversized.status, 'error');
  assert.equal(oversized.code, 'compression_request_too_large');
  const unresolved = kernel.planNativeCompactWindow({
    contents: [{ role: 'user', parts: [{ inlineData: {
      mimeType: 'image/png', sourcePath: '/tmp/not-admitted.png', sizeBytes: 123
    } }] }],
    inputCapacityTokens: 100_000
  });
  assert.equal(unresolved.status, 'error');
  assert.equal(unresolved.code, 'media_size_unknown');
  const managed = kernel.planNativeCompactWindow({
    contents: [{ role: 'user', parts: [{ inlineData: {
      mimeType: 'image/png', attachmentId: 'attachment-one', sizeBytes: 123,
      sha256: 'a'.repeat(64), storage: 'managed'
    } }] }],
    inputCapacityTokens: 100_000
  });
  assert.equal(managed.status, 'ready');
});

test('stored runtime_context规划与Adapter共用typed envelope和4K渲染', () => {
  const projectedDelivery = kernel.projectRuntimeDeliveryForModel({
    kind: 'child_answer',
    status: 'submitted',
    phase: 'current_turn',
    deliveryId: 'delivery-planner-runtime',
    inboxItemId: 'inbox-planner-runtime',
    targetTurnId: 'turn-parent-planner-runtime',
    deliveredAt: '2026-08-09T12:00:00.000Z',
    childExecutionId: 'child-planner-runtime',
    answerBridgeId: 'bridge-planner-runtime',
    submissionId: 'submission-planner-runtime',
    sourceTurnId: 'turn-child-planner-runtime',
    title: 'large child result',
    contentType: 'text/plain',
    content: `HEAD-${'x'.repeat(1_000_000)}-TAIL`
  });
  assert.ok(projectedDelivery);
  assert.ok(kernel.estimateTextTokens(projectedDelivery.content) > 100_000);
  const stored = {
    segmentKind: 'runtime_context',
    messageRole: null,
    contentType: projectedDelivery.contentType,
    content: projectedDelivery.content
  };
  const planned = kernel.projectStoredModelFacingWindow([stored]);
  const fullRequest = {
    kind: 'full-model-request',
    modelRequestId: 'runtime-planner-request',
    conversationId: 'runtime-planner-conversation',
    attemptSeq: '1',
    socketGeneration: '1',
    providerId: 'runtime-planner-provider',
    modelId: 'runtime-planner-model',
    authoritySnapshot: {
      model: {
        providerConfigId: 'runtime-planner-provider',
        provider: 'openai-compatible',
        modelId: 'runtime-planner-model'
      },
      toolPolicy: { allowedTools: [], preset: 'custom', sourceConfigs: {} },
      systemPrompt: { text: '' }
    },
    recipe: {
      kind: 'reliable-agent-turn',
      tools: [],
      modelHandleCatalog: {
        entries: [{ kind: 'child', ref: 'A1', target: 'bridge-planner-runtime' }]
      }
    },
    context: [{ segmentId: 'runtime-planner-segment', ...stored }],
    attachmentCatalogState: { catalog: [], placements: [] }
  };
  const adapter = new kernel.LlmCapabilityFullRequestAdapter('runtime-planner-provider', {});
  const sent = adapter.estimateFullRequestInput(fullRequest);
  assert.equal(planned.tokenCount, sent.contextTokens);
  assert.ok(planned.tokenCount <= kernel.RUNTIME_DELIVERY_MODEL_MAX_TOKENS + 4);
  assert.match(planned.contents[0].parts[0].text, /truncated runtime result/);
  assert.match(planned.contents[0].parts[0].text, /HEAD-/);
  assert.match(planned.contents[0].parts[0].text, /-TAIL/);
});

test('stored runtime_context hard-cut旧裸文本而不按普通user消息估算', () => {
  assert.throws(
    () => kernel.projectStoredModelFacingWindow([{
      segmentKind: 'runtime_context',
      messageRole: null,
      contentType: 'text/plain',
      content: 'legacy naked runtime result'
    }]),
    /must use application\/vnd\.limcode\.runtime-delivery-model\+json/
  );
});


test('truncate根Token估算复用模型投影而不是持久化字节长度', () => {
  const contextSource = fs.readFileSync('backend/reliableKernel/contextSequence.ts', 'utf8');
  const truncateStart = contextSource.indexOf('public async prepareMessageTruncateMutation');
  const truncateEnd = contextSource.indexOf('public async prepareMessageRetryMutation', truncateStart);
  const truncateBody = contextSource.slice(truncateStart, truncateEnd);
  assert.match(truncateBody, /estimateEditableContextTokens\(prefix\)/);
  assert.doesNotMatch(truncateBody, /prefix\.reduce\([\s\S]*contentObject\.byte_length/);
  assert.match(
    contextSource,
    /private async estimateEditableContextTokens[\s\S]*?projectStoredModelFacingWindow\(/
  );

  const turnSource = fs.readFileSync('backend/reliableKernel/turnControlPlane.ts', 'utf8');
  assert.equal(
    turnSource.match(/contentEstimatedTokens: estimateStoredMessageContentTokens\(/g)?.length,
    2,
    '两个带替换消息的truncate入口都必须传入语义Token估算'
  );
});

test('当前扩展替换命令等待process真实终态，其他命令保持请求等待期', () => {
  const selfUpdate = [
    'code --uninstall-extension your-publisher.limcode-test',
    'code --install-extension ./limcode-test-0.0.14.vsix'
  ].join(' && ');

  assert.equal(kernel.effectiveProcessForegroundWaitMs(selfUpdate, 1_000, 120_000), 120_000);
  assert.equal(kernel.effectiveProcessForegroundWaitMs(selfUpdate, 60_000, 5_000), 60_000);
  assert.equal(
    kernel.effectiveProcessForegroundWaitMs(
      'code --uninstall-extension publisher.other && code --install-extension ./other.vsix',
      1_000,
      120_000
    ),
    1_000
  );
  assert.equal(
    kernel.effectiveProcessForegroundWaitMs(
      'code --install-extension ./limcode-test-0.0.14.vsix',
      1_000,
      120_000
    ),
    1_000
  );
});
