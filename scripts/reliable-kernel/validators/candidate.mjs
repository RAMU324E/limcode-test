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

function runPhaseCCheck(checkId) {
  const args = [
    path.join(root, 'scripts/reliable-kernel/run-candidate-check.mjs'),
    `--check=${checkId}`,
    ...(option('commit') ? [`--commit=${option('commit')}`] : [])
  ];
  const run = childProcess.spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024
  });
  const diagnostic = [run.stdout, run.stderr].filter(Boolean).join('\n').trim();
  if (run.error) return `${checkId}执行失败：${run.error.message}`;
  if (run.status !== 0) return diagnostic || `${checkId}退出码${run.status}`;
  if (diagnostic) console.log(diagnostic);
  return null;
}

/** @type {Map<string, () => string | null>} */
const implemented = new Map([
  ['candidate.turn-sole-execution-identity', () => runPhaseCCheck('candidate.turn-sole-execution-identity')]
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
