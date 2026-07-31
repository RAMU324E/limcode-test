import fs from 'node:fs/promises';
import path from 'node:path';

export const TURN_CONTROL_PLANE_SOURCE_FILES = Object.freeze([
  'backend/reliableKernel/turnControlPlane.ts',
  'backend/reliableKernel/turnRecovery.ts',
  'backend/reliableKernel/contentAddressedStore.ts',
  'backend/reliableKernel/repositories.ts',
  'backend/reliableKernel/runtimeDatabase.ts',
  'backend/reliableKernel/databaseWorker.ts',
  'backend/reliableKernel/databaseWorkerProtocol.ts',
  'backend/reliableKernel/schema/domainsCore.ts',
  'backend/reliableKernel/index.ts'
]);

const FORBIDDEN_AUTHORITY_PATTERNS = Object.freeze([
  { label: '旧 Run 标识类型', pattern: /\bRunId\b/ },
  { label: '旧 Agent 执行对象', pattern: /\bAgentRun\b/ },
  { label: '旧 camelCase fork 来源', pattern: /\bsourceRun(?:Id)?\b/ },
  { label: '旧 snake_case fork 来源', pattern: /\bsource_run(?:_id)?\b/ },
  { label: '旧 CommandReceipt commandId', pattern: /\bcommandId\b/ },
  { label: 'ECS world 依赖', pattern: /(?:backend\/)?world\/modules/ },
  { label: '旧 lifecycle authority 依赖', pattern: /backend\/reliability|\.\.\/reliability/ }
]);

export function findTurnAuthoritySourceProblems(source, label = '<source>') {
  const problems = [];
  for (const forbidden of FORBIDDEN_AUTHORITY_PATTERNS) {
    if (forbidden.pattern.test(source)) problems.push(`${label}包含${forbidden.label}`);
  }
  return problems;
}

export async function validateTurnControlPlaneSources(root) {
  const problems = [];
  for (const relativePath of TURN_CONTROL_PLANE_SOURCE_FILES) {
    const source = await fs.readFile(path.join(root, relativePath), 'utf8');
    problems.push(...findTurnAuthoritySourceProblems(source, relativePath));
  }
  return problems;
}
