import { IconTransfer } from '@tabler/icons-vue';
import type { ToolDisplayResolver, ToolDisplaySection } from './types';

export const transferFilesToolDisplay: ToolDisplayResolver = (context) => {
  const args = asRecord(context.args);
  const transfers = Array.isArray(args?.transfers) ? args.transfers.map(asRecord).filter(Boolean) : [];
  const transferLines = transfers.map((transfer, index) => {
    const from = endpoint(transfer?.fromEnvironment, transfer?.fromPath);
    const to = endpoint(transfer?.toEnvironment, transfer?.toPath);
    return `${index + 1}. ${from} → ${to}`;
  });
  const inputSections: ToolDisplaySection[] = transferLines.length > 0
    ? [{ kind: 'input', title: '传输项目', text: transferLines.join('\n') }]
    : [];

  const result = resultRecord(context.result);
  const outputRows = [
    row('状态', text(result?.status)),
    row('结果', typeof result?.ok === 'boolean' ? result.ok ? '成功' : '失败' : undefined),
    row('数量', numberText(result?.count ?? result?.total)),
    row('说明', text(result?.reason) ?? text(result?.message) ?? text(result?.error))
  ].filter((item): item is { label: string; value: string } => item !== undefined);

  return {
    headerIcon: IconTransfer,
    inputSections,
    outputSections: outputRows.length > 0
      ? [{ kind: 'output', title: '传输结果', rows: outputRows, rowStyle: 'keyValue' }]
      : []
  };
};

function endpoint(environment: unknown, path: unknown): string {
  const environmentText = text(environment);
  const displayEnvironment = !environmentText
    ? '工作环境'
    : environmentText.startsWith('work-env-') ? '工作环境' : environmentText;
  return `${displayEnvironment}:${text(path) ?? '?'}`;
}

function resultRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  return asRecord(record?.detail) ?? asRecord(record?.output) ?? record;
}

function row(label: string, value: string | undefined): { label: string; value: string } | undefined {
  return value ? { label, value } : undefined;
}

function numberText(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
