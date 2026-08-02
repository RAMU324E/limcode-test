import * as vscode from 'vscode';
import { RELIABLE_DIFF_SCHEME } from '../../../shared/extensionIdentity';
import {
  FileChangeControlPlane,
  type FileChangeDiffMemberSnapshot
} from '../../reliableKernel/fileEffects';
import type { ReliableDiagnosticObserver } from '../../reliableKernel/diagnosticJournal';

export interface ReliableFileDiffOpenResult {
  status: 'opened' | 'failed';
  message: string;
  openedMembers: number;
}

/**
 * Read-only Diff editor backed by immutable Runtime CAS facts.
 *
 * URIs carry only the FileChangeSetMember id and side. The content provider resolves the current
 * fenced Runtime on every read, so an editor can reload after an Extension Host restart and never
 * depends on a short-lived in-memory preview document or the current Workspace bytes.
 */
export class VscodeReliableFileDiffEditor implements vscode.Disposable {
  private readonly provider: vscode.Disposable;
  private disposed = false;

  public constructor(
    private readonly files: FileChangeControlPlane,
    private readonly diagnostics?: ReliableDiagnosticObserver
  ) {
    this.provider = vscode.workspace.registerTextDocumentContentProvider(RELIABLE_DIFF_SCHEME, {
      provideTextDocumentContent: (uri) => this.provideContent(uri)
    });
  }

  public async openToolCallDiff(toolCallId: string): Promise<ReliableFileDiffOpenResult> {
    const startedAt = Date.now();
    this.diagnostics?.observe({
      eventKind: 'diff.open.requested',
      scopeKind: 'tool_call',
      scopeId: toolCallId,
      metadata: { toolCallId }
    });
    try {
      const members = (await this.files.readToolDiffMembers(toolCallId))
        .filter((member) => isTextDiffOperation(member.operation));
      this.diagnostics?.observe({
        eventKind: 'diff.cas.loaded',
        scopeKind: 'tool_call',
        scopeId: toolCallId,
        metadata: {
          toolCallId,
          memberCount: members.length,
          elapsedMs: Math.max(0, Date.now() - startedAt)
        }
      });
      if (members.length === 0) {
        this.diagnostics?.observe({
          eventKind: 'diff.open.failed',
          scopeKind: 'tool_call',
          scopeId: toolCallId,
          metadata: {
            toolCallId,
            status: 'failed',
            reasonCode: 'no-text-members',
            elapsedMs: Math.max(0, Date.now() - startedAt)
          }
        });
        return { status: 'failed', message: '该文件变更没有可显示的文本 Diff。', openedMembers: 0 };
      }
      for (let index = 0; index < members.length; index += 1) {
        const member = members[index];
        assertExactUtf8(member.baseContent, member.targetPath, '原始');
        assertExactUtf8(member.targetContent, member.targetPath, '目标');
        const left = reliableDiffUri(member, 'base');
        const right = reliableDiffUri(member, 'target');
        await vscode.commands.executeCommand(
          'vscode.diff',
          left,
          right,
          diffTitle(member),
          { preview: members.length === 1 || index === members.length - 1 }
        );
      }
      this.diagnostics?.observe({
        eventKind: 'diff.editor.shown',
        scopeKind: 'tool_call',
        scopeId: toolCallId,
        metadata: {
          toolCallId,
          memberCount: members.length,
          elapsedMs: Math.max(0, Date.now() - startedAt)
        }
      });
      return {
        status: 'opened',
        message: members.length === 1 ? '已从可靠记录打开完成态 Diff。' : `已从可靠记录打开 ${members.length} 个完成态 Diff。`,
        openedMembers: members.length
      };
    } catch (error) {
      this.diagnostics?.observe({
        eventKind: 'diff.open.failed',
        scopeKind: 'tool_call',
        scopeId: toolCallId,
        metadata: {
          toolCallId,
          status: 'failed',
          errorName: error instanceof Error ? error.name : 'UnknownError',
          elapsedMs: Math.max(0, Date.now() - startedAt)
        }
      });
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : '无法打开可靠文件 Diff。',
        openedMembers: 0
      };
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.provider.dispose();
  }

  private async provideContent(uri: vscode.Uri): Promise<string> {
    if (this.disposed) throw new Error('可靠 Diff provider 已关闭。');
    const input = parseReliableDiffUri(uri);
    const member = await this.files.readDiffMember(input.memberId);
    const bytes = input.role === 'base' ? member.baseContent : member.targetContent;
    return decodeExactUtf8(bytes, member.targetPath, input.role === 'base' ? '原始' : '目标');
  }
}

function reliableDiffUri(member: FileChangeDiffMemberSnapshot, role: 'base' | 'target'): vscode.Uri {
  return vscode.Uri.from({
    scheme: RELIABLE_DIFF_SCHEME,
    authority: 'file-change',
    path: `/${member.targetPath.replace(/^\/+/, '') || 'file'}`,
    query: new URLSearchParams({ memberId: member.memberId, role }).toString()
  });
}

function parseReliableDiffUri(uri: vscode.Uri): { memberId: string; role: 'base' | 'target' } {
  if (uri.scheme !== RELIABLE_DIFF_SCHEME || uri.authority !== 'file-change') {
    throw new Error('无效的可靠 Diff URI。');
  }
  const query = new URLSearchParams(uri.query);
  const memberId = query.get('memberId')?.trim();
  const role = query.get('role');
  if (!memberId || (role !== 'base' && role !== 'target')) throw new Error('可靠 Diff URI 缺少成员身份。');
  return { memberId, role };
}

function isTextDiffOperation(operation: FileChangeDiffMemberSnapshot['operation']): boolean {
  return operation === 'create_file' || operation === 'replace_file' || operation === 'delete_file';
}

function assertExactUtf8(bytes: Buffer | null, targetPath: string, role: string): void {
  decodeExactUtf8(bytes, targetPath, role);
}

function decodeExactUtf8(bytes: Buffer | null, targetPath: string, role: string): string {
  if (!bytes) return '';
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error(`${targetPath} 的${role}内容不是精确 UTF-8 文本，无法在文本 Diff 中显示。`);
  }
  return text;
}

function diffTitle(member: FileChangeDiffMemberSnapshot): string {
  if (member.operation === 'create_file') return `${member.targetPath}: 空文件 ↔ 新建内容`;
  if (member.operation === 'delete_file') return `${member.targetPath}: 删除前 ↔ 空文件`;
  return `${member.targetPath}: 修改前 ↔ 修改后`;
}
