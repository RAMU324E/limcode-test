import { simplifyToolResponseForModel } from '../tools/responseSimplifier';

export interface BackgroundProcessExitNotificationInput {
  processId: string;
  toolName: 'shell' | 'bash';
  command: string;
  status: 'exited' | 'killed' | 'abnormal';
  exitCode: number;
  killed: boolean;
  stdout: string;
  stderr: string;
  droppedChars?: number;
}

export function serializedBackgroundProcessExitNotification(payload: BackgroundProcessExitNotificationInput): string {
  const toolStatus = payload.exitCode === 0 && !payload.killed ? 'success' : 'error';
  const toolLikeResponse = simplifyToolResponseForModel(payload.toolName, toolStatus, {
    command: payload.command,
    exitCode: payload.exitCode,
    killed: payload.killed,
    stdout: payload.stdout,
    stderr: payload.stderr,
    status: payload.status,
    processId: payload.processId,
    running: false,
    ...(payload.droppedChars !== undefined && payload.droppedChars > 0 ? { droppedChars: payload.droppedChars } : {})
  });

  return [
    '[Background command exited]',
    '后台 shell/bash 命令已结束。下面是按普通 shell 工具响应规则精简后的结果，请把它当作该后台命令主动返回给当前对话的结果：',
    JSON.stringify(toolLikeResponse, null, 2),
    '处理要求：请基于这次后台命令结果继续处理；不要重复启动同一个命令。如确实需要更多或更新日志，可调用 shell/bash 的 mode=output 并传入结果中的 processId。'
  ].join('\n\n');
}
