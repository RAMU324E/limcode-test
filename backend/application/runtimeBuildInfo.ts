import { createHash, randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import type { RuntimeBuildInfoRecord } from '../../shared/protocol';
import { EXTENSION_PACKAGE_NAME, EXTENSION_VERSION } from '../../shared/extensionIdentity';
import { LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION } from '../capabilities/openAIResponsesWebSocketIdentity';

const activatedAt = Date.now();
const runtimeInstanceId = randomUUID();
const providerVersion = readPackageVersion('unified-llm-provider');
const webSocketVersion = readPackageVersion('ws');
const proxyAgentVersion = readPackageVersion('https-proxy-agent');
const activatedBuildFingerprint = calculateCurrentBuildFingerprint();

export const RUNTIME_BUILD_INFO: RuntimeBuildInfoRecord = Object.freeze({
  extensionName: EXTENSION_PACKAGE_NAME,
  extensionVersion: EXTENSION_VERSION,
  providerVersion,
  webSocketVersion,
  proxyAgentVersion,
  wsImplementation: LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION,
  buildFingerprint: activatedBuildFingerprint,
  currentBuildFingerprint: activatedBuildFingerprint,
  reloadRequired: false,
  runtimeInstanceId,
  activatedAt,
  processId: process.pid,
  nodeVersion: process.version
});

/**
 * 每次 Hello 都重新读取磁盘上的关键编译产物。
 * `npm run compile` 会替换这些文件，但已运行的 Extension Host 仍持有旧模块；两者指纹不同即说明必须重载。
 */
export function getRuntimeBuildInfo(): RuntimeBuildInfoRecord {
  const currentBuildFingerprint = calculateCurrentBuildFingerprint();
  const reloadRequired = currentBuildFingerprint !== RUNTIME_BUILD_INFO.buildFingerprint;
  return {
    ...RUNTIME_BUILD_INFO,
    currentBuildFingerprint,
    reloadRequired,
    ...(reloadRequired ? { reloadReason: 'extension_files_changed' as const } : {})
  };
}

function readPackageVersion(packageName: string): string {
  try {
    const packagePath = require.resolve(`${packageName}/package.json`);
    const record = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: unknown };
    return typeof record.version === 'string' && record.version.trim() ? record.version.trim() : 'unknown';
  } catch {
    return 'unknown';
  }
}

function calculateCurrentBuildFingerprint(): string {
  const hash = createHash('sha256');
  hash.update(`${EXTENSION_PACKAGE_NAME}\n${EXTENSION_VERSION}\n${LIMCODE_OPENAI_RESPONSES_WS_IMPLEMENTATION}\n`);
  for (const modulePath of runtimeModulePaths()) {
    try {
      hash.update(modulePath);
      hash.update(readFileSync(modulePath));
    } catch {
      hash.update(`unreadable:${modulePath}`);
    }
  }
  return hash.digest('hex').slice(0, 16);
}

function runtimeModulePaths(): string[] {
  const paths = [__filename];
  for (const moduleId of [
    '../capabilities/llmProvider',
    '../capabilities/openAIResponsesWebSocketSession',
    '../capabilities/openAIResponsesWebSocketConnection',
    '../capabilities/openAIResponsesWebSocketMultiplexer',
    '../capabilities/openAIResponsesNativeControl',
    '../../shared/openAIResponsesCapabilities',
    '../reliableKernel/nativeToolFacts',
    '../reliableKernel/nativeSteering',
    '../reliableKernel/nativeRequestSession',
    '../reliableKernel/nativeCompressionGuard',
    '../reliableKernel/conversationForkContext',
    '../capabilities/llmStreamEventBatcher',
    '../world/modules/tools/systems/ToolCallPreviewSystem',
    '../../shared/protocol',
    'unified-llm-provider/package.json',
    'ws/package.json',
    'https-proxy-agent/package.json'
  ]) {
    try {
      paths.push(require.resolve(moduleId));
    } catch {
      paths.push(moduleId);
    }
  }
  return paths;
}
