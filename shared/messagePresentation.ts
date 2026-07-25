import {
  isFunctionResponsePart,
  type MessageContent,
  type MessagePresentation,
  type MsgRole
} from './protocol';

export interface MessagePresentationLike {
  role: MsgRole;
  presentation?: MessagePresentation;
  content: MessageContent;
}

/** Model-only control messages remain in conversation context but do not belong to the visible transcript. */
export function isInternalMessage(message: MessagePresentationLike): boolean {
  return message.presentation === 'internal';
}

/** The normal conversation timeline omits both model-only control input and raw function-response messages. */
export function isUserVisibleTimelineMessage(message: MessagePresentationLike): boolean {
  return !isInternalMessage(message) && !message.content.parts.some(isFunctionResponsePart);
}
