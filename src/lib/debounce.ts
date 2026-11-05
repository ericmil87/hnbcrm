export interface Debounced<T> {
  /** Schedule `fn(arg)`; a newer call replaces the pending one. */
  call: (arg: T) => void;
  /** Run the pending call now (no-op when none). */
  flush: () => void;
  /** Drop the pending call. */
  cancel: () => void;
  pending: () => boolean;
}

/** Trailing debounce that keeps the last argument and can be flushed (e.g. on unmount). */
export function createDebounced<T>(fn: (arg: T) => void, ms: number): Debounced<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: { arg: T } | null = null;

  const run = () => {
    timer = null;
    const item = last;
    last = null;
    if (item) fn(item.arg);
  };

  return {
    call(arg) {
      last = { arg };
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, ms);
    },
    flush() {
      if (timer) clearTimeout(timer);
      run();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      last = null;
    },
    pending: () => last !== null,
  };
}
