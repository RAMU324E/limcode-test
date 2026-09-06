import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';
import { EXTENSION_VERSION } from '../../../shared/extensionIdentity';
import type { DebugCaptureManifest } from '../../../shared/debugCapture';

// 随运行模块加载固定来源，之后重新编译不能把旧进程伪装成新版本。
const activatedSource = readSource();
export function debugCaptureSource(hostBootId: string): DebugCaptureManifest['source'] { return { ...structuredClone(activatedSource), hostBootId }; }

function readSource(): Omit<DebugCaptureManifest['source'], 'hostBootId'> {
  const extensionRoot = path.resolve(__dirname, '../../../../..');
  let sourceCommit = '未找到构建来源';
  try {
    const record = JSON.parse(readFileSync(path.join(extensionRoot, 'dist/extension/reliable-kernel-compile-provenance.json'), 'utf8'));
    sourceCommit = `${record.commitSha ?? record.commit ?? '未知提交'}${record.worktreeClean === false ? ':含未提交改动' : ''}`;
  } catch { /* 缺失明确保留，不推测提交号。 */ }
  const moduleHashes: Record<string, string> = {};
  const modules = ['../../capabilities/llmProvider', '../../capabilities/openAIResponsesWebSocketSession', '../../capabilities/terminalValidatedFetch', '../../capabilities/llmStreamEventBatcher', '../llmCapabilityProviderAdapter', '../webviewFeedBridge', './observer', './analyzer'];
  for (const id of modules) {
    try { moduleHashes[id] = hash(readFileSync(require.resolve(id))); } catch { moduleHashes[id] = '无法读取'; }
  }
  try {
    const root = path.dirname(require.resolve('unified-llm-provider/package.json'));
    for (const name of ['observation', 'response', 'providers/base', 'formats/openai-responses']) moduleHashes[`provider/${name}`] = hash(readFileSync(path.join(root, 'dist/llm', `${name}.js`)));
  } catch { moduleHashes.provider = '无法读取'; }
  try {
    const assets = path.join(extensionRoot, 'dist/webview/assets');
    for (const name of readdirSync(assets).filter(name => name.endsWith('.js')).sort()) moduleHashes[`webview/${name}`] = hash(readFileSync(path.join(assets, name)));
  } catch { moduleHashes.webview = '无法读取'; }
  return { extensionVersion: EXTENSION_VERSION, sourceCommit, moduleHashes };
}
function hash(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }
