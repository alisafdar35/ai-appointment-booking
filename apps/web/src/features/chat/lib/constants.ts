/**
 * Mirrors the `max(2000)` in sendMessageSchema. The schema holds the number as
 * a literal, so a test asserts the two agree rather than trusting a comment.
 */
export const MESSAGE_MAX_LENGTH = 2000;

/** The counter appears only once a message is long enough for the limit to matter. */
export const COUNTER_VISIBLE_FROM = 1800;
