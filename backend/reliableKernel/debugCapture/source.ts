import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
    const compilationProof = path.join(extensionRoot, 'dist/extension/reliable-kernel-compile-provenance.json');
    // 编译证明不随安装包分发；安装包使用同次构建生成的发布证明。
    const proof = existsSync(compilationProof) ? compilationProof : path.join(extensionRoot, 'dist/build-provenance.json');
    const record = JSON.parse(readFileSync(proof, 'utf8'));
    if (typeof record.commitSha === 'string' && /^[a-f0-9]{40}$/.test(record.commitSha)) {
      sourceCommit = `${record.commitSha}${record.worktreeClean === false ? ':含未提交改动' : ''}`;
    }
  } catch { /* 缺失明确保留，不推测提交号。 */ }
  const moduleHashes: Record<string, string> = {};
  const modules = ['../../capabilities/llmProvider', '../../capabilities/openAIResponsesWebSocketSession', '../../capabilities/terminalValidatedFetch', '../../capabilities/llmStreamEventBatcher', '../llmCapabilityProviderAdapter', '../webviewFeedBridge', './observer', './analyzer', './controller', './files', './service', './source', '../../../shared/debugCaptureEncoding'];
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
