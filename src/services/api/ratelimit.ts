/**
 * The per-source throttle on unauthenticated credential and recovery endpoints.
 *
 * `authentication-and-access.md` AC12 asks for throttling "against a single
 * account **or from a single source**". `@zeddev/identity` owns the first half:
 * a failed-attempt counter on the account row, shared by every instance because
 * it lives in the database. This is the second half, and it covers what the
 * account counter cannot: a caller spraying one password across ten thousand
 * addresses never trips any single account's counter, and a caller hammering the
 * password-reset endpoint is not failing anything at all — it is using the
 * service to mail a victim, which only a source-based limit can stop.
 *
 * ## Why in-process rather than shared
 *
 * Counted per process, so N instances admit N times the configured limit — the
 * configuration reference says so. A shared counter would need either a table
 * written on every anonymous request or another always-on backing service, and
 * `cost-efficient-operation.md` makes the second a non-starter. The account-level
 * lockout is the control that must be exact, and it is; this one only needs to
 * make a sweep expensive, which a per-instance bound does.
 *
 * ## Why a fixed window
 *
 * A fixed window admits up to twice the limit across a boundary, which a sliding
 * log would not. It also costs one integer per source instead of one timestamp per
 * request, and memory is the resource a small VPS runs out of first. At a default
 * of thirty requests per ten minutes the burst allowance is not what stops an
 * attack; the order of magnitude is.
 */

import type { Clock } from '@zeddev/time';

export interface RateDecision {
  readonly allowed: boolean;
  /** How long until the source's window resets. Zero when allowed. */
  readonly retryAfterMs: number;
}

interface Window {
  startedAtMs: number;
  count: number;
}

/**
 * Sources tracked before expired windows are swept.
 *
 * Without a bound, a caller rotating source addresses grows the map until the
 * process runs out of memory — turning a throttle into a denial-of-service
 * vector against the service it protects.
 */
const SWEEP_THRESHOLD = 10_000;

export class FixedWindowRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #clock: Clock;
  readonly #windows = new Map<string, Window>();

  constructor(options: { readonly limit: number; readonly windowMs: number; readonly clock: Clock }) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#clock = options.clock;
  }

  /** Sources currently tracked. Exposed so a test can prove the sweep bounds memory. */
  get trackedSources(): number {
    return this.#windows.size;
  }

  /** Count one request from `source`, and say whether it may proceed. */
  take(source: string): RateDecision {
    const now = this.#clock.now().getTime();
    if (this.#windows.size >= SWEEP_THRESHOLD) this.#sweep(now);

    let window = this.#windows.get(source);
    if (window === undefined || now - window.startedAtMs >= this.#windowMs) {
      window = { startedAtMs: now, count: 0 };
      this.#windows.set(source, window);
    }

    if (window.count >= this.#limit) {
      return { allowed: false, retryAfterMs: window.startedAtMs + this.#windowMs - now };
    }
    window.count += 1;
    return { allowed: true, retryAfterMs: 0 };
  }

  #sweep(now: number): void {
    for (const [source, window] of this.#windows) {
      if (now - window.startedAtMs >= this.#windowMs) this.#windows.delete(source);
    }
    // Every tracked source is inside its window — a flood of distinct addresses
    // within one window. Dropping them all forgets some sources' counts early,
    // which admits a little more than the limit; the alternative is unbounded
    // memory, which admits nothing at all once the process dies.
    if (this.#windows.size >= SWEEP_THRESHOLD) this.#windows.clear();
  }
}
