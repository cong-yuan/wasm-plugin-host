import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createImeCompositionGuard, isImeProcessingKey } from '../ime-composition';

describe('isImeProcessingKey', () => {
  it('detects isComposing on the event and nativeEvent', () => {
    expect(isImeProcessingKey({ isComposing: true })).toBe(true);
    expect(isImeProcessingKey({ nativeEvent: { isComposing: true } })).toBe(true);
    expect(isImeProcessingKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });

  it('detects legacy IME keyCode 229', () => {
    expect(isImeProcessingKey({ keyCode: 229 })).toBe(true);
    expect(isImeProcessingKey({ which: 229 })).toBe(true);
    expect(isImeProcessingKey({ nativeEvent: { keyCode: 229 } })).toBe(true);
  });
});

describe('createImeCompositionGuard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks Enter while composing and does not swallow (IME must finish)', () => {
    const guard = createImeCompositionGuard();
    guard.onCompositionStart();
    const event = { isComposing: true, keyCode: 229 };
    expect(guard.shouldBlockEnterSubmit(event)).toBe(true);
    expect(guard.shouldSwallowBlockedEnter(event)).toBe(false);
  });

  it('swallows the ghost Enter after compositionend before the suppress timer fires', () => {
    const guard = createImeCompositionGuard();
    guard.onCompositionStart();
    guard.onCompositionEnd();

    const ghostEnter = { isComposing: false, keyCode: 13 };
    expect(guard.shouldBlockEnterSubmit(ghostEnter)).toBe(true);
    expect(guard.shouldSwallowBlockedEnter(ghostEnter)).toBe(true);

    // A following Enter should submit normally.
    expect(guard.shouldBlockEnterSubmit({ isComposing: false, keyCode: 13 })).toBe(false);
  });

  it('clears suppress after timer when no Enter arrives so a later Enter can send', () => {
    const guard = createImeCompositionGuard();
    guard.onCompositionStart();
    guard.onCompositionEnd();
    expect(guard.shouldBlockEnterSubmit({ keyCode: 13 })).toBe(true);

    vi.runAllTimers();

    expect(guard.shouldBlockEnterSubmit({ isComposing: false, keyCode: 13 })).toBe(false);
  });

  it('does not block Latin Enter without composition', () => {
    const guard = createImeCompositionGuard();
    expect(guard.shouldBlockEnterSubmit({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});
