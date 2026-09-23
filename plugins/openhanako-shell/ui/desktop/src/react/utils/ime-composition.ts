/**
 * IME (e.g. Chinese pinyin) helpers for Enter-to-submit composers.
 *
 * Chromium/Electron often fires compositionend before the Enter keydown that
 * confirmed the candidate, with isComposing already false. A naive
 * `!isComposing` check then falsely submits. This guard swallows that one
 * ghost Enter while still letting a later Enter send.
 */

export type ImeKeyLike = {
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
  nativeEvent?: {
    isComposing?: boolean;
    keyCode?: number;
    which?: number;
  };
};

/** True when the browser marks the key as IME processing (incl. legacy 229). */
export function isImeProcessingKey(event: ImeKeyLike): boolean {
  const native = event.nativeEvent;
  if (event.isComposing || native?.isComposing) return true;
  const keyCode = event.keyCode ?? native?.keyCode ?? event.which ?? native?.which;
  return keyCode === 229;
}

export type ImeCompositionGuard = {
  isComposing: () => boolean;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  /** Enter must not submit (active IME or post-compositionend ghost Enter). */
  shouldBlockEnterSubmit: (event: ImeKeyLike) => boolean;
  /**
   * After shouldBlockEnterSubmit is true: swallow (preventDefault) the ghost
   * Enter; return false during live composition so the IME can finish.
   */
  shouldSwallowBlockedEnter: (event: ImeKeyLike) => boolean;
};

export function createImeCompositionGuard(): ImeCompositionGuard {
  let composing = false;
  let suppressEnter = false;
  let clearSuppressTimer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (clearSuppressTimer === null) return;
    clearTimeout(clearSuppressTimer);
    clearSuppressTimer = null;
  };

  return {
    isComposing: () => composing,
    onCompositionStart: () => {
      clearTimer();
      composing = true;
      suppressEnter = false;
    },
    onCompositionEnd: () => {
      composing = false;
      suppressEnter = true;
      clearTimer();
      // If no Enter follows in this turn, drop the suppress flag.
      clearSuppressTimer = setTimeout(() => {
        suppressEnter = false;
        clearSuppressTimer = null;
      }, 0);
    },
    shouldBlockEnterSubmit: (event) => {
      if (isImeProcessingKey(event) || composing) return true;
      return suppressEnter;
    },
    shouldSwallowBlockedEnter: (event) => {
      if (isImeProcessingKey(event) || composing) return false;
      if (!suppressEnter) return false;
      suppressEnter = false;
      clearTimer();
      return true;
    },
  };
}
