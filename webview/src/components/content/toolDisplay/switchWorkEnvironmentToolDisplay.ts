import { IconSwitch } from '@tabler/icons-vue';
import type { ToolDisplayResolver, ToolDisplaySection } from './types';

export const switchWorkEnvironmentToolDisplay: ToolDisplayResolver = (context) => {
  const args = asRecord(context.args);
  const workEnvironmentRef = text(args?.workEnvironmentRef);
  const hasCanonicalTarget = text(args?.workEnvironmentId) !== undefined;
  const inputSections: ToolDisplaySection[] = workEnvironmentRef || hasCanonicalTarget
    ? [{
        kind: 'input',
        title: '目标环境',
        rows: [{ label: '工作环境', value: workEnvironmentRef ?? '当前选择的工作环境' }],
        rowStyle: 'keyValue'
      }]
    : [];

  const result = resultRecord(context.result);
  const outputRows = [
    row('状态', text(result?.status)),
    row('结果', typeof result?.ok === 'boolean' ? result.ok ? '成功' : '失败' : undefined),
    row('是否变化', typeof result?.unchanged === 'boolean' ? result.unchanged ? '未变化' : '已变化' : undefined),
    row('说明', text(result?.reason) ?? text(result?.message) ?? text(result?.error))
  ].filter((item): item is { label: string; value: string } => item !== undefined);

  return {
    headerIcon: IconSwitch,
    inputSections,
    outputSections: outputRows.length > 0
      ? [{ kind: 'output', title: '切换结果', rows: outputRows, rowStyle: 'keyValue' }]
      : []
  };
};

function resultRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return asRecord(record?.detail) ?? asRecord(record?.output) ?? record;
}

function row(label: string, value: string | undefined): { label: string; value: string } | undefined {
  return value ? { label, value } : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
