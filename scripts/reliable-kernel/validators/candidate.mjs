import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// candidate 出口校验器：每个原子断言使用稳定 check.id。
// 未实现项诚实输出 PENDING，不通过 description 正则合并或伪造检查。
const GROUP_ID = 'candidate';
const root = process.cwd();
const registry = JSON.parse(
  fs.readFileSync(path.join(root, 'docs/architecture/reliable-kernel/contracts/gate-registry.json'), 'utf8')
);
const group = (registry.validatorGroups ?? []).find((entry) => entry.id === GROUP_ID);
if (!group) {
  console.error(`gate-registry.json缺少校验器组：${GROUP_ID}`);
  process.exit(2);
}
const gate = (registry.gates ?? []).find((entry) => entry.id === group.introducedAt);
const stageLabel = (gate?.stages ?? []).join('-') || '未知';

function option(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

const phaseEChecks = new Set([
  'candidate.context-storage-growth',
  'candidate.context-compression-node-bound',
  'candidate.provider-continuation-disabled-full-request',
  'candidate.compression-immutable-replacement'
]);
const phaseFChecks = new Set([
  'candidate.conversation-fork-links',
  'candidate.subagent-answer-restart-delivery',
  'candidate.subagent-cancel-subtree',
  'candidate.client-snapshot-bounds',
  'candidate.client-change-batch-bounds',
  'candidate.client-queue-bounds',
  'candidate.client-snapshot-feed-barrier',
  'candidate.old-writer-not-routed',
  'candidate.recovery.answer-inbox-invariant',
  'candidate.recovery.pending-delivery',
  'candidate.recovery.foreground-wait-expired',
  'candidate.recovery.cancelled-subtree-incomplete',
  'candidate.parent-handling-matrix'
]);

function runCandidateCheck(checkId) {
  const runner = checkId === 'candidate.turn-sole-execution-identity'
    ? 'run-candidate-check.mjs'
    : phaseEChecks.has(checkId)
      ? 'run-phase-e-check.mjs'
      : phaseFChecks.has(checkId)
        ? 'run-phase-f-check.mjs'
        : 'run-phase-d-check.mjs';
  const args = [
    path.join(root, 'scripts/reliable-kernel', runner),
    `--check=${checkId}`,
    ...(option('commit') ? [`--commit=${option('commit')}`] : [])
  ];
  const run = childProcess.spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024
  });
  const diagnostic = [run.stdout, run.stderr].filter(Boolean).join('\n').trim();
  if (run.error) return `${checkId}执行失败：${run.error.message}`;
  if (run.status !== 0) return diagnostic || `${checkId}退出码${run.status}`;
  if (diagnostic) console.log(diagnostic);
  return null;
}

/** @type {Map<string, () => string | null>} */
const implemented = new Map([
  ['candidate.turn-sole-execution-identity', () => runCandidateCheck('candidate.turn-sole-execution-identity')],
  ['candidate.tool-model-result-exactly-once', () => runCandidateCheck('candidate.tool-model-result-exactly-once')],
  ['candidate.file-proposal-result-separated', () => runCandidateCheck('candidate.file-proposal-result-separated')],
  ['candidate.effect-receipt-reconcile', () => runCandidateCheck('candidate.effect-receipt-reconcile')],
  ['candidate.context-storage-growth', () => runCandidateCheck('candidate.context-storage-growth')],
  ['candidate.context-compression-node-bound', () => runCandidateCheck('candidate.context-compression-node-bound')],
  ['candidate.provider-continuation-disabled-full-request', () => runCandidateCheck('candidate.provider-continuation-disabled-full-request')],
  ['candidate.compression-immutable-replacement', () => runCandidateCheck('candidate.compression-immutable-replacement')],
  ['candidate.attachment-cas-ingest', () => runCandidateCheck('candidate.attachment-cas-ingest')],
  ['candidate.mcp-effect-recovery', () => runCandidateCheck('candidate.mcp-effect-recovery')],
  ['candidate.process-wrapper-recovery', () => runCandidateCheck('candidate.process-wrapper-recovery')],
  ['candidate.process-output-bounds', () => runCandidateCheck('candidate.process-output-bounds')],
  ['candidate.recovery.effect-intent-hanging', () => runCandidateCheck('candidate.recovery.effect-intent-hanging')],
  ['candidate.recovery.file-change-unresolved', () => runCandidateCheck('candidate.recovery.file-change-unresolved')],
  ['candidate.conversation-fork-links', () => runCandidateCheck('candidate.conversation-fork-links')],
  ['candidate.subagent-answer-restart-delivery', () => runCandidateCheck('candidate.subagent-answer-restart-delivery')],
  ['candidate.subagent-cancel-subtree', () => runCandidateCheck('candidate.subagent-cancel-subtree')],
  ['candidate.client-snapshot-bounds', () => runCandidateCheck('candidate.client-snapshot-bounds')],
  ['candidate.client-change-batch-bounds', () => runCandidateCheck('candidate.client-change-batch-bounds')],
  ['candidate.client-queue-bounds', () => runCandidateCheck('candidate.client-queue-bounds')],
  ['candidate.client-snapshot-feed-barrier', () => runCandidateCheck('candidate.client-snapshot-feed-barrier')],
  ['candidate.old-writer-not-routed', () => runCandidateCheck('candidate.old-writer-not-routed')],
  ['candidate.recovery.answer-inbox-invariant', () => runCandidateCheck('candidate.recovery.answer-inbox-invariant')],
  ['candidate.recovery.pending-delivery', () => runCandidateCheck('candidate.recovery.pending-delivery')],
  ['candidate.recovery.foreground-wait-expired', () => runCandidateCheck('candidate.recovery.foreground-wait-expired')],
  ['candidate.recovery.cancelled-subtree-incomplete', () => runCandidateCheck('candidate.recovery.cancelled-subtree-incomplete')],
  ['candidate.parent-handling-matrix', () => runCandidateCheck('candidate.parent-handling-matrix')]
]);

const failures = [];
const pending = [];
for (const check of group.checks ?? []) {
  const handler = implemented.get(check.id);
  if (!handler) {
    pending.push(check);
    continue;
  }
  try {
    const problem = handler();
    if (problem) failures.push(`${check.id}（${check.description}）：${problem}`);
  } catch (error) {
    failures.push(`${check.id}（${check.description}）：${error instanceof Error ? error.message : String(error)}`);
  }
}

for (const check of pending) console.error(`PENDING: ${check.id} — ${check.description}（归属阶段 ${check.ownerStage ?? stageLabel}）`);
for (const failure of failures) console.error(`失败：${failure}`);
if (pending.length || failures.length) {
  console.error(`${GROUP_ID}出口校验未通过：${pending.length}项待实现，${failures.length}项失败。`);
  process.exit(1);
}
console.log(`${GROUP_ID}出口校验通过：${(group.checks ?? []).length}项稳定ID检查全部实现并通过。`);
