'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Within this distance of the end counts as "reading the latest messages". */
const NEAR_BOTTOM_PX = 96;
/** Scroll events fired by our own smooth scroll must not be mistaken for the user scrolling away. */
const PROGRAMMATIC_SCROLL_MS = 400;

interface Options {
  /** Changes when a different conversation is shown: jump straight to its end. */
  resetKey: string;
  /** Changes whenever content is added: follow it only if the reader is at the end. */
  changeKey: string | number;
  /** False while the conversation's history is still loading. */
  ready: boolean;
  /** Show the top instead of the end: an empty conversation's starter prompts read from the top down. */
  pinToTop: boolean;
}

const prefersReducedMotion = () =>
  typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Chat scrolling that respects the reader.
 *
 * New content scrolls into view only while the reader is already near the end.
 * Someone scrolled up to re-read an earlier message is never yanked down;
 * instead `showJump` turns on so the UI can offer a "Jump to latest" button.
 * Switching conversations always lands at the end, instantly, because that is
 * a navigation, not new content arriving: the first content shown after a
 * switch is placed without animation, and only later additions glide.
 */
export function useStickToBottom<Scroller extends HTMLElement, Content extends HTMLElement>({
  resetKey,
  changeKey,
  ready,
  pinToTop,
}: Options) {
  const scrollerRef = useRef<Scroller>(null);
  const contentRef = useRef<Content>(null);
  const stuckRef = useRef(true);
  const ignoreScrollUntil = useRef(0);
  const settledRef = useRef(false);
  const pinToTopRef = useRef(pinToTop);
  useLayoutEffect(() => {
    pinToTopRef.current = pinToTop;
  }, [pinToTop]);
  const [showJump, setShowJump] = useState(false);

  const scrollToEnd = useCallback((behavior: ScrollBehavior) => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    ignoreScrollUntil.current = Date.now() + (behavior === 'smooth' ? PROGRAMMATIC_SCROLL_MS : 0);
    scroller.scrollTo({ top: pinToTopRef.current ? 0 : scroller.scrollHeight, behavior });
  }, []);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || Date.now() < ignoreScrollUntil.current) return;
    const nearEnd = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= NEAR_BOTTOM_PX;
    stuckRef.current = nearEnd;
    setShowJump(!nearEnd);
  }, []);

  useLayoutEffect(() => {
    stuckRef.current = true;
    settledRef.current = false;
    setShowJump(false);
    scrollToEnd('auto');
  }, [resetKey, scrollToEnd]);

  useEffect(() => {
    if (stuckRef.current) scrollToEnd(settledRef.current && !prefersReducedMotion() ? 'smooth' : 'auto');
    else setShowJump(true);
    if (ready) settledRef.current = true;
  }, [changeKey, resetKey, ready, pinToTop, scrollToEnd]);

  // Cards and images change height after they mount; keep following while stuck.
  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stuckRef.current) scrollToEnd('auto');
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToEnd]);

  /** The reader just sent something: whatever they were scrolled to, show the reply. */
  const follow = useCallback(() => {
    stuckRef.current = true;
  }, []);

  const jumpToLatest = useCallback(() => {
    stuckRef.current = true;
    setShowJump(false);
    scrollToEnd(prefersReducedMotion() ? 'auto' : 'smooth');
  }, [scrollToEnd]);

  return { scrollerRef, contentRef, onScroll, showJump, follow, jumpToLatest };
}
