/** The scope still has live work; its existing stop-and-delete command retries after settlement. */
export class ConversationDeletionBlockedError extends Error {
  public readonly code = 'conversation-deletion-blocked';

  public constructor(message: string) {
    super(message);
    this.name = 'ConversationDeletionBlockedError';
  }
}
