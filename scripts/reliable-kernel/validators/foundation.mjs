import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {
  currentCommit,
  DEFAULT_BASELINE_RELATIVE_PATH,
  validateBaselineFile
} from '../lib/baseline-contract.mjs';

// foundation 出口校验器：handler 只按稳定 check.id 登记。
// 未实现项诚实输出 PENDING 并以退出码 1 结束，不匹配可变 description。
const GROUP_ID = 'foundation';
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

function runPhaseBCheck(checkId) {
  const args = [
    path.join(root, 'scripts/reliable-kernel/run-foundation-check.mjs'),
    `--check=${checkId}`,
    `--commit=${option('commit') ?? currentCommit(root)}`
  ];
  const run = childProcess.spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 8 * 1024 * 1024
  });
  const diagnostic = [run.stdout, run.stderr].filter(Boolean).join('\n').trim();
  if (run.error) return `${checkId}执行失败：${run.error.message}`;
  if (run.status !== 0) return diagnostic || `${checkId}退出码${run.status}`;
  if (diagnostic) console.log(diagnostic);
  return null;
}

function checkBaselinesNonPlaceholder() {
  const expectedCommit = option('commit') ?? currentCommit(root);
  const result = validateBaselineFile({
    root,
    baselinePath: option('baseline') ?? DEFAULT_BASELINE_RELATIVE_PATH,
    expectedCommit
  });
  if (result.problems.length) return result.problems.join('；');
  const summary = result.summary;
  console.log(
    `PASS: foundation.baselines-non-placeholder — ${result.baselinePath}，`
      + `${summary.platform}/${summary.arch}，target=${summary.targetId}，targetMatch=${summary.matchesCurrentHost}，`
      + `commit=${summary.commitSha}，measuredAt=${summary.measuredAt}，`
      + `build=${summary.buildDurationMs}ms，package=${summary.packageDurationMs}ms，vsix=${summary.vsixBytes} bytes。`
  );
  return null;
}

/** @type {Map<string, () => string | null>} */
const implemented = new Map([
  ['foundation.sqlite-driver-load', () => runPhaseBCheck('foundation.sqlite-driver-load')],
  ['foundation.single-db-worker', () => runPhaseBCheck('foundation.single-db-worker')],
  ['foundation.schema-repositories', () => runPhaseBCheck('foundation.schema-repositories')],
  ['foundation.cas-publish-before-reference', () => runPhaseBCheck('foundation.cas-publish-before-reference')],
  ['foundation.root-binding-fence', () => runPhaseBCheck('foundation.root-binding-fence')],
  ['foundation.no-legacy-fallback', () => runPhaseBCheck('foundation.no-legacy-fallback')],
  ['foundation.empty-root-current-epoch', () => runPhaseBCheck('foundation.empty-root-current-epoch')],
  ['foundation.baselines-non-placeholder', checkBaselinesNonPlaceholder]
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
