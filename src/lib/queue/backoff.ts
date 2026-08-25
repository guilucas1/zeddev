/**
 * The queue's default retry curve.
 *
 * The curve itself lives in `@zeddev/time` — it is a duration policy, and
 * `@zeddev/storage` needs the same one. What stays here is the *choice of
 * parameters*, because the right curve is a property of what is being retried,
 * not of the mechanism, and `message-delivery-reliability.md` says as much when
 * it leaves "the exact retry count, backoff shape, and acknowledgement timeout"
 * to the implementation phase.
 *
 * One second doubling to a five-minute ceiling: fast enough that a blip costs an
 * end customer no visible delay, slow enough that a sustained upstream outage is
 * not amplified by the retries. Five minutes is also comfortably inside WhatsApp's
 * 24-hour customer service window, so a job retrying at the ceiling is not
 * retrying itself out of the window it needs to land in.
 */

import { exponentialBackoff, type Backoff } from '@zeddev/time';

export const DEFAULT_BACKOFF: Backoff = exponentialBackoff({ baseMs: 1000, maxMs: 300_000 });
