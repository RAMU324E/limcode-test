import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import childProcess from 'node:child_process';

const root = process.cwd();
const CI_TEST_FILES = Object.freeze([
  'tests/bottomStickyScrollerScheduler.test.cjs',
  'tests/commandRelaxedPolicy.test.cjs',
  'tests/fileWatcherScope.test.cjs',
  'tests/llmErrorRedaction.test.cjs',
  'tests/localFileResources.test.cjs',
  'tests/openAIResponsesWebSocket.test.cjs',
  'tests/openAIResponsesWebSocketSession.test.cjs',
  'tests/processSpoolCleanup.test.cjs',
  'tests/reliable-kernel/attachment-catalog-projection.test.mjs',
  'tests/reliable-kernel/attachment-ingest-boundary.test.mjs',
  'tests/reliable-kernel/canonical-base64.test.mjs',
  'tests/reliable-kernel/command-router-interaction.test.mjs',
  'tests/reliable-kernel/child-agent-status-controls.test.cjs',
  'tests/reliable-kernel/client-feed-window-rollover.test.mjs',
  'tests/reliable-kernel/conversation-deletion-recovery.test.mjs',
  'tests/reliable-kernel/conversation-fork-context.test.mjs',
  'tests/reliable-kernel/current-turn-task-projection.test.mjs',
  'tests/reliable-kernel/frontend-copy-guardrails.test.cjs',
  'tests/reliable-kernel/guidance-queue.test.mjs',
  'tests/reliable-kernel/compression-progress-ui.test.mjs',
  'tests/reliable-kernel/configuration-authority.test.mjs',
  'tests/reliable-kernel/diagnostic-journal.test.mjs',
  'tests/reliable-kernel/debug-capture-controller.test.mjs',
  'tests/reliable-kernel/debug-capture-provenance.test.mjs',
  'tests/reliable-kernel/debug-capture-files.test.mjs',
  'tests/reliable-kernel/debug-capture-ui.test.mjs',
  'tests/reliable-kernel/edit-tool-invariants.test.cjs',
  'tests/reliable-kernel/llm-capability-provider-adapter.test.mjs',
  'tests/reliable-kernel/tool-boundary-regressions.test.mjs',
  'tests/reliable-kernel/model-system-prompt-prefix.test.mjs',
  'tests/reliable-kernel/native-compact-media.test.mjs',
  'tests/reliable-kernel/phase-b-foundation.test.mjs',
  'tests/reliable-kernel/plan-interrupt-recovery.test.mjs',
  'tests/reliable-kernel/product-composition.test.mjs',
  'tests/reliable-kernel/provider-semantic-watchdog.test.mjs',
  'tests/reliable-kernel/provider-wire-invariant.test.mjs',
  'tests/reliable-kernel/provider-websocket-policy.test.mjs',
  'tests/reliable-kernel/reliable-control-lifecycle.test.mjs',
  'tests/reliable-kernel/reliable-outbox-ui-contract.test.mjs',
  'tests/reliable-kernel/segmented-summary-chunking.test.mjs',
  'tests/reliable-kernel/streaming-output-regressions.test.mjs',
  'tests/reliable-kernel/storage-lock-multiprocess.test.cjs',
  'tests/reliable-kernel/stream-reset-tool-idempotency.test.mjs',
  'tests/reliable-kernel/vscode-fs-local-read.test.cjs',
  'tests/reliable-kernel/webview-feed-lifecycle.test.mjs',
  'tests/reliable-kernel/waiting-interaction-cancellation.test.mjs',
  'tests/reliable-kernel/interaction-auto-approval.test.mjs',
  'tests/reliable-kernel/platform-runtime-compatibility.test.mjs',
  'tests/reliable-kernel/workspace-runtime-isolation.test.mjs',
  'tests/runAgentToolSchema.test.cjs',
  'tests/settingsRevisionConflict.test.cjs',
  'tests/storageLockRace.test.cjs',
  'tests/vscodeStorageJsonDurability.test.cjs',
  'tests/webviewLocalResources.test.cjs'
]);
// The full local scan stays inside tests/reliable-kernel so retired world/file
// tests cannot pull deleted modules back into the compiled closure. CI uses the
// explicit list above to add only reviewed, current product-boundary tests.
const testsRoot = path.join(root, 'tests', 'reliable-kernel');
const files = [];
function walk(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute);
    else if (/\.test\.(?:cjs|mjs|js)$/.test(entry.name)) files.push(path.relative(root, absolute));
  }
}
if (process.argv.includes('--ci')) {
  for (const file of CI_TEST_FILES) {
    if (!fs.existsSync(path.join(root, file))) {
      console.error(`CI关键测试不存在：${file}`);
      process.exit(1);
    }
    files.push(file);
  }
} else {
  walk(testsRoot);
}
files.sort();
if (files.length === 0) {
  console.error('在tests/reliable-kernel/**/*.test.{cjs,mjs,js}下没有找到当前可靠内核本机测试。');
  process.exit(1);
}
if (process.argv.includes('--list')) {
  for (const file of files) console.log(file);
  process.exit(0);
}
console.log(
  process.argv.includes('--ci')
    ? `按稳定顺序运行${files.length}个已纳入版本库的CI关键测试文件。`
    : `按稳定顺序运行${files.length}个当前可靠内核本机测试文件。`
);
const TEST_TIMEOUT_MS = 10 * 60 * 1000;
// Several gate tests intentionally read/write shared evidence files. Node's default per-file
// parallelism makes those durable fixtures race each other, so the advertised stable order must be
// real rather than merely sorting the argv list.
const result = childProcess.spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...files],
  { cwd: root, stdio: 'inherit', timeout: TEST_TIMEOUT_MS }
);
if (result.error) {
  if (result.error.code === 'ETIMEDOUT') {
    console.error(`本机测试超过${Math.round(TEST_TIMEOUT_MS / 60000)}分钟上限，已强制终止。`);
    process.exit(1);
  }
  throw result.error;
}
process.exit(result.status ?? 1);
