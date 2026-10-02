/**
 * What a conversation is called until something names it: its first message,
 * or its booking. Matches the chat_sessions.title column default (001_init.sql).
 */
export const DEFAULT_SESSION_TITLE = 'New conversation';

const TITLE_MAX_LENGTH = 60;

/**
 * A first message as a conversation title. Cut at a word boundary and marked
 * with an ellipsis: a hard cut ended titles mid-word ("…on Wednesday, Octo"),
 * and the sidebar cannot tell a cut title from a complete one.
 */
export function titleFromMessage(content: string): string {
  const text = content.trim().replace(/\s+/g, ' ');
  if (text.length <= TITLE_MAX_LENGTH) return text;

  const head = text.slice(0, TITLE_MAX_LENGTH - 1);
  const endsOnWord = text[TITLE_MAX_LENGTH - 1] === ' ';
  const lastSpace = head.lastIndexOf(' ');
  // A single word longer than the limit has no boundary to cut at, so it is cut as is.
  const cut = endsOnWord || lastSpace <= 0 ? head : head.slice(0, lastSpace);
  return `${cut.replace(/[\s,.;:!?-]+$/, '')}…`;
}
