/**
 * Retry backoff.
 *
 * Lives in `@zeddev/time` because it is a *duration policy*, and durations are
 * what this package owns. It was written in `@zeddev/queue` and moved here once
 * `@zeddev/storage` needed the same curve: an object store on a free tier answers
 * a burst with `SlowDown` for the same reason a queue's upstream does, and two
 * copies of a retry curve is how two subsystems come to quietly disagree about
 * what "backoff" means. §1 of IMPLEMENTATION_PLAN.md makes `src/lib/*` the
 * standard library precisely so that this move is the cheap option and copying
 * is the expensive one.
 *
 * `message-delivery-reliability.md` requires retry "with backoff, up to a defined
 * retry allowance" and leaves the shape open: "The exact retry count, backoff
 * shape, and acknowledgement timeout ... are left open for the implementation
 * phase." So the shape is a decision made here, and it is injectable rather than
 * baked in, because the right curve for an outbound WhatsApp send and the right
 * curve for a media fetch are not the same — the same spec says as much.
 *
 * Two properties are not negotiable.
 *
 * **Exponential, not linear.** The failure this protects against is an upstream
 * that is down, and a linear retry from every worker keeps the load on a
 * recovering service roughly constant, which is how a brief outage becomes a long
 * one.
 *
 * **Jittered.** Without jitter, a hundred jobs that failed together retry
 * together, forever, in lockstep. Full jitter — a uniform draw from `[0, delay]`
 * — spreads them and is the variant with the best measured behavior under
 * contention. The random source is injectable so the property is testable rather
 * than merely asserted; a test can pin it and still exercise the real code path.
 */

export interface Backoff {
  /** Delay before the given attempt is retried. `attempt` is 1 for the first failure. */
  (attempt: number): number;
}

export interface ExponentialBackoffOptions {
  /** Delay after the first failure, before jitter. */
  readonly baseMs: number;
  /** Ceiling on the pre-jitter delay, so attempt 20 does not schedule a retry next year. */
  readonly maxMs: number;
  /**
   * Fraction of the delay that is randomised, in `[0, 1]`.
   *
   * At 1 the delay is a uniform draw from `[0, computed]` — full jitter. At 0 it
   * is deterministic, which is only appropriate in a test that is asserting the
   * curve itself.
   */
  readonly jitter?: number | undefined;
  readonly random?: (() => number) | undefined;
}

export function exponentialBackoff(options: ExponentialBackoffOptions): Backoff {
  const jitter = options.jitter ?? 1;
  const random = options.random ?? Math.random;
  return (attempt: number): number => {
    // `attempt` is 1-based, so the first retry waits `baseMs` rather than double
    // it. 2 ** 30 is clamped before it can overflow into a meaningless number.
    const exponent = Math.min(Math.max(attempt, 1) - 1, 30);
    const uncapped = options.baseMs * 2 ** exponent;
    const capped = Math.min(uncapped, options.maxMs);
    const fixed = capped * (1 - jitter);
    return Math.round(fixed + capped * jitter * random());
  };
}
