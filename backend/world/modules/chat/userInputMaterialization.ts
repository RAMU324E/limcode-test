import type { CommandSink, Entity, WorldReader } from '../../../ecs/types';
import type { MessageContent, MessagePresentation } from '../../../../shared/protocol';
import { stableIds } from '../../../reliability/stableIdFactory';
import { spawnCheckpointBarrier } from '../checkpoint/barriers';
import { Checkpoint } from '../checkpoint/components';
import { checkpointRequestsEnabled, enqueueCheckpointRequest } from '../checkpoint/events';
import { spawnUserContentMessage, spawnUserMessage } from './bundles';
import { Conversation } from './components';
import { conversationMessages } from './queries';

export function materializeUserInputMessage(
  world: WorldReader,
  cmd: CommandSink,
  conversation: Entity,
  conversationId: string,
  content: MessageContent,
  presentation: MessagePresentation = 'visible'
): Entity {
  const isFirstMessage = checkpointRequestsEnabled() && conversationMessages(world, conversation).length === 0;
  const needsInitialCheckpoint = isFirstMessage && !hasInitialCheckpoint(world, conversation);
  const messageId = stableIds.nextMessageId();
  const message = spawnInputMessage(cmd, conversation, content, messageId, presentation);
  if (needsInitialCheckpoint) requestInitialCheckpoint(cmd, conversationId);
  requestUserMessageCheckpoints(cmd, conversationId, conversation, message, messageId);
  return message;
}

export function spawnInputMessage(
  cmd: CommandSink,
  conversation: Entity,
  content: MessageContent,
  messageId = stableIds.nextMessageId(),
  presentation: MessagePresentation = 'visible'
): Entity {
  const identity = { messageId, revisionId: stableIds.nextMessageRevisionId(), presentation };
  if (content.parts.length === 1 && 'text' in content.parts[0]) return spawnUserMessage(cmd, conversation, content.parts[0].text, identity);
  return spawnUserContentMessage(cmd, conversation, content, identity);
}

function hasInitialCheckpoint(world: WorldReader, conversation: Entity): boolean {
  return world.query(Checkpoint).some((entity) => {
    const checkpoint = world.get(entity, Checkpoint);
    return checkpoint?.conversation === conversation && checkpoint.trigger === 'conversation_initial';
  });
}

function requestInitialCheckpoint(cmd: CommandSink, conversationId: string): void {
  enqueueCheckpointRequest(cmd, { conversationId, trigger: 'conversation_initial' });
}

function requestUserMessageCheckpoints(cmd: CommandSink, conversationId: string, conversation: Entity, floorMessage: Entity, floorMessageId: string): void {
  if (!checkpointRequestsEnabled()) return;
  const beforeCheckpointId = stableIds.nextCheckpointId();
  spawnCheckpointBarrier(cmd, {
    checkpointId: beforeCheckpointId,
    conversation,
    trigger: 'user_message_before',
    targetKind: 'message_llm',
    targetMessage: floorMessage,
    targetMessageId: floorMessageId
  });
  enqueueCheckpointRequest(cmd, {
    checkpointId: beforeCheckpointId,
    conversationId,
    trigger: 'user_message_before',
    floorMessageId,
    anchorPosition: 'before'
  });
  enqueueCheckpointRequest(cmd, {
    conversationId,
    trigger: 'user_message_after',
    floorMessageId,
    anchorPosition: 'after'
  });
}

export function conversationIdForEntity(world: WorldReader, conversation: Entity): string | undefined {
  return world.get(conversation, Conversation)?.id;
}
