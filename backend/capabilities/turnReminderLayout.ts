/** 每轮提醒和重新注入输入的共同布局；Claude 专用的 clear_at 编码由内容标记表达。 */
import type { MessageContent } from '../../shared/protocol';
import { isRecord } from './llmStreamEventProjection';

/** 内核附在提醒内容上的进程内标记；从不持久化，也不会出现在线上请求里。 */
export interface TurnReminderMarker {
  /** `current`：本请求的提醒；`history`：之前某次请求发过、紧挨在那次请求模型输出之前的提醒。 */
  placement: 'current' | 'history';
  /** Process-local compression accounting; stripped together with the marker before sending. */
  budgetSegmentId?: string;
  /** 该请求冻结的发送方式；user 快照在切换 provider 后仍保留普通 user 身份。 */
  delivery?: 'user_history' | 'claude_turn_scoped';
  /**
   * 缺省是每轮提醒。`reinjected_input` 是重新注入的当前 Turn 输入：`history` 为某次请求作为尾巴发过的原文，
   * 放回那次请求的模型输出与它的提醒之前；`current` 为本请求的尾巴副本，只在本窗口已有它的历史副本时才带这个标记。
   */
  kind?: 'reinjected_input';
  /**
   * 轮内系统消息模式下的身份拆分（只有带运行状态卡的每轮提醒才有）：`user` 是运行状态卡原文，始终作为 user 消息；
   * `system` 是其余部分，可以作为轮内系统消息，缺省时整条都是运行状态卡。parts 里仍是整条原文（尾巴模式逐字节不变）。
   */
  identitySplit?: { user: string; system?: string };
}

export type TurnReminderContent = MessageContent & { turnReminder: TurnReminderMarker };
export type ClaudeSystemMessageContent = MessageContent & { claudeSystemMessage: { clearAt: 'next_user_message' } };

export type TurnReminderLayout = 'claude_turn_scoped' | 'tail';

/**
 * 一条提醒最终的发送形态：`system` 轮内系统消息；`user` 普通 user 消息（显示、计 token）；`omitted` 不发送；
 * `split` 运行状态卡作为 user 消息、其余部分作为紧随其后的轮内系统消息（见 {@link TurnReminderMarker.identitySplit}）。
 */
export type TurnReminderDelivery = 'system' | 'split' | 'user' | 'omitted';

export function turnReminderContent(text: string, marker: TurnReminderMarker): TurnReminderContent {
  return { role: 'user', parts: [{ text }], turnReminder: { ...marker } };
}

/** 给已投影的重新注入输入加上标记；parts 原样保留。 */
export function markedReinjectedInput(
  content: MessageContent,
  placement: TurnReminderMarker['placement'],
  delivery?: TurnReminderMarker['delivery'],
  budgetSegmentId?: string
): TurnReminderContent {
  return { role: 'user', parts: content.parts, turnReminder: { placement, kind: 'reinjected_input',
    ...(delivery ? { delivery } : {}), ...(budgetSegmentId ? { budgetSegmentId } : {}) } };
}

export function readTurnReminderMarker(content: MessageContent): TurnReminderMarker | undefined {
  const marker = (content as Partial<TurnReminderContent>).turnReminder;
  if (!isRecord(marker)) return undefined;
  if (marker.placement !== 'current' && marker.placement !== 'history') return undefined;
  if (marker.kind !== undefined && marker.kind !== 'reinjected_input') return undefined;
  const split = marker.identitySplit;
  if (split !== undefined && (!isRecord(split) || typeof split.user !== 'string'
    || (split.system !== undefined && typeof split.system !== 'string'))) return undefined;
  return marker as unknown as TurnReminderMarker;
}

/**
 * 每条提醒的发送形态，按内容顺序计算；只看提醒前面最近一条已发送的非 system 内容的角色，
 * 因此只取决于那段稳定历史，同一历史每次得到同样的结果。
 * user_history 始终保留普通 user 历史，已有历史副本时省略当前重注入副本。
 * Claude 提醒由 layout 决定：轮内模式保留历史；tail 模式只发送本轮内容。
 */
export function turnReminderDeliveries(
  contents: readonly MessageContent[],
  layout: TurnReminderLayout
): Array<TurnReminderDelivery | undefined> {
  const deliveries: Array<TurnReminderDelivery | undefined> = [];
  let previousRole: MessageContent['role'] | undefined;
  for (const content of contents) {
    const marker = readTurnReminderMarker(content);
    if (!marker) {
      deliveries.push(undefined);
      previousRole = content.role;
      continue;
    }
    let delivery: TurnReminderDelivery;
    if (marker.delivery === 'user_history') {
      delivery = marker.kind === 'reinjected_input' && marker.placement === 'current' ? 'omitted' : 'user';
    } else if (layout === 'tail') delivery = marker.placement === 'current' ? 'user' : 'omitted';
    else if (marker.kind === 'reinjected_input') delivery = marker.placement === 'history' ? 'user' : 'omitted';
    else if (previousRole !== 'user' || (marker.identitySplit && marker.identitySplit.system === undefined)) delivery = 'user';
    else delivery = marker.identitySplit ? 'split' : 'system';
    deliveries.push(delivery);
    if (delivery === 'user' || delivery === 'split') previousRole = 'user';
  }
  return deliveries;
}

/** 去掉内核标记、按发送形态排好的内容；没有任何提醒标记时返回同一个数组（逐字节不变）。 */
export function layoutTurnReminderContents(
  contents: MessageContent[],
  layout: TurnReminderLayout
): MessageContent[] {
  return projectTurnReminderLayout(contents, layout).contents;
}

/** 同一次布局中折算实际输入边界，避免按文本匹配或重编码历史。 */
export function projectTurnReminderLayout(
  contents: MessageContent[],
  layout: TurnReminderLayout,
  readBreakpointBeforeContentIndex?: number
): { contents: MessageContent[]; readBreakpointBeforeContentIndex?: number } {
  if (!contents.some((content) => readTurnReminderMarker(content) !== undefined)) {
    return { contents, readBreakpointBeforeContentIndex };
  }
  const deliveries = turnReminderDeliveries(contents, layout);
  const laidOut: MessageContent[] = [];
  let readBoundary: number | undefined;
  contents.forEach((content, index) => {
    if (index === readBreakpointBeforeContentIndex) readBoundary = laidOut.length;
    const delivery = deliveries[index];
    if (delivery === undefined) {
      laidOut.push(content);
      return;
    }
    if (delivery === 'omitted') return;
    if (delivery === 'split') {
      const split = readTurnReminderMarker(content)!.identitySplit!;
      laidOut.push({ role: 'user', parts: [{ text: split.user }] });
      laidOut.push({
        role: 'user', parts: [{ text: split.system! }], claudeSystemMessage: { clearAt: 'next_user_message' }
      } as ClaudeSystemMessageContent);
      return;
    }
    const plain: MessageContent = { role: 'user', parts: content.parts };
    laidOut.push(delivery === 'system'
      ? { ...plain, claudeSystemMessage: { clearAt: 'next_user_message' } } as ClaudeSystemMessageContent
      : plain);
  });
  if (readBreakpointBeforeContentIndex === contents.length) readBoundary = laidOut.length;
  return { contents: laidOut, ...(readBoundary === undefined ? {} : { readBreakpointBeforeContentIndex: readBoundary }) };
}

/**
 * 估算用：一条历史提醒发出后仍会显示、计 token 的部分（官方 “Token counting follows what renders”）。
 * 按 user 消息发出的整条计入；拆分发出的只有运行状态卡那条 user 消息计入；已清除的系统消息与不发送的都不计。
 */
export function visibleHistoryTurnReminder(
  content: MessageContent,
  delivery: TurnReminderDelivery | undefined
): MessageContent | undefined {
  if (delivery === 'user') return content;
  if (delivery !== 'split') return undefined;
  const split = readTurnReminderMarker(content)?.identitySplit;
  return split ? { role: 'user', parts: [{ text: split.user }] } : undefined;
}
