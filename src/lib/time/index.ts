/**
 * Clock port.
 *
 * Why a port rather than calling `Date.now()`: three separate spec-mandated
 * behaviors are timer-driven, and none of them is testable against a real clock.
 *
 *   - `message-burst-aggregation.md`'s quiet-period window and maximum turn
 *     extension, which decide what counts as one conversational turn.
 *   - `conversation-memory.md`'s inactivity reset window.
 *   - `client-offboarding-and-data-retention.md`'s retention window, which may be
 *     measured in weeks.
 *
 * Testing a weeks-long retention window by waiting is not an option, and testing
 * a burst window by sleeping makes the suite slow and flaky. So time is injected.
 *
 * `monotonicMs` is separate from `now` on purpose. Wall-clock time can jump
 * backwards (NTP correction, DST on a misconfigured host); a retry backoff or a
 * burst window computed from a backwards jump either fires immediately or hangs.
 * Durations must be measured monotonically, timestamps recorded from wall clock.
 */

export {
  exponentialBackoff,
  type Backoff,
  type ExponentialBackoffOptions,
} from './backoff.ts';

/** Milliseconds. A named alias because a bare `number` in a signature invites unit bugs. */
export type Millis = number;

export interface Clock {
  /** Wall-clock time. Use for timestamps that are stored or displayed. */
  now(): Date;
  /** Monotonically non-decreasing counter. Use for measuring elapsed durations. */
  monotonicMs(): Millis;
  /** Resolves after at least `ms`. */
  sleep(ms: Millis, options?: { signal?: AbortSignal | undefined }): Promise<void>;
  /**
   * Schedule `fn` to run after `ms`. Returns a cancel function.
   *
   * Present so that scheduled work can be driven deterministically by the fake;
   * a service that reaches for `setTimeout` directly is untestable in the same way
   * one that reaches for `Date.now()` is.
   */
  setTimer(ms: Millis, fn: () => void): () => void;
}

/** The real clock. The only implementation that should reach production. */
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  monotonicMs(): Millis {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }

  sleep(ms: Millis, options?: { signal?: AbortSignal | undefined }): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const signal = options?.signal;
      if (signal?.aborted === true) {
        rejectPromise(signal.reason);
        return;
      }
      const handle = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolvePromise();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(handle);
        rejectPromise(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  setTimer(ms: Millis, fn: () => void): () => void {
    const handle = setTimeout(fn, ms);
    // Do not hold the event loop open. A scheduler's timer should never be the
    // reason a service refuses to shut down.
    handle.unref?.();
    return () => clearTimeout(handle);
  }
}

interface ScheduledTask {
  readonly id: number;
  readonly dueAt: Millis;
  readonly fn: () => void;
}

/**
 * A controllable clock for tests.
 *
 * `advance` fires every timer whose due time has passed, in due-time order, and
 * moves the clock to each timer's due time before firing it. That ordering
 * matters: a burst-aggregation test that schedules a quiet-period timer and a
 * maximum-extension timer must observe them in the order real time would deliver
 * them, or it proves nothing about the real behavior.
 */
export class FakeClock implements Clock {
  #wallMs: number;
  #monotonicMs: number;
  #tasks: ScheduledTask[] = [];
  #nextId = 1;

  constructor(start: Date | string = '2026-01-01T00:00:00.000Z') {
    this.#wallMs = typeof start === 'string' ? new Date(start).getTime() : start.getTime();
    // Deliberately not equal to the wall clock, so that any code which conflates
    // the two produces an obviously wrong number in tests rather than a
    // plausible one that happens to pass.
    this.#monotonicMs = 1_000_000;
  }

  now(): Date {
    return new Date(this.#wallMs);
  }

  monotonicMs(): Millis {
    return this.#monotonicMs;
  }

  sleep(ms: Millis, options?: { signal?: AbortSignal | undefined }): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const signal = options?.signal;
      if (signal?.aborted === true) {
        rejectPromise(signal.reason);
        return;
      }
      const cancel = this.setTimer(ms, () => {
        signal?.removeEventListener('abort', onAbort);
        resolvePromise();
      });
      const onAbort = (): void => {
        cancel();
        rejectPromise(signal?.reason);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  setTimer(ms: Millis, fn: () => void): () => void {
    const id = this.#nextId;
    this.#nextId += 1;
    this.#tasks.push({ id, dueAt: this.#monotonicMs + Math.max(0, ms), fn });
    return () => {
      this.#tasks = this.#tasks.filter((t) => t.id !== id);
    };
  }

  /** Number of timers still pending. Lets a test assert that work was scheduled. */
  get pendingTimers(): number {
    return this.#tasks.length;
  }

  /**
   * Move time forward by `ms`, firing due timers along the way.
   *
   * Awaitable so that callers can `await clock.advance(...)` and let any
   * promise continuations a fired timer resolved run before asserting. Without
   * that, a test would assert on state that the microtask queue has not yet
   * produced, and would fail for reasons unrelated to the behavior under test.
   */
  async advance(ms: Millis): Promise<void> {
    if (ms < 0) throw new RangeError('FakeClock.advance does not accept negative durations');
    const target = this.#monotonicMs + ms;

    for (;;) {
      const due = this.#tasks
        .filter((t) => t.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id)[0];
      if (due === undefined) break;

      const delta = due.dueAt - this.#monotonicMs;
      this.#monotonicMs = due.dueAt;
      this.#wallMs += delta;
      this.#tasks = this.#tasks.filter((t) => t.id !== due.id);
      due.fn();
      // Let promise continuations chained onto this timer settle before the next.
      await Promise.resolve();
    }

    const remaining = target - this.#monotonicMs;
    this.#monotonicMs = target;
    this.#wallMs += remaining;
    await Promise.resolve();
  }

  /**
   * Jump the wall clock without advancing monotonic time or firing timers.
   *
   * Models an NTP correction. Exists so that the guarantee "durations are
   * measured monotonically" can actually be asserted: code that computes a
   * backoff or a burst window from `now()` will visibly misbehave under this,
   * and code that uses `monotonicMs()` will not.
   */
  setWallClock(to: Date | string): void {
    this.#wallMs = typeof to === 'string' ? new Date(to).getTime() : to.getTime();
  }
}
