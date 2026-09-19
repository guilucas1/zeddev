/**
 * The retry loop's timing, driven by a FakeClock. The conformance suite proves
 * what is retried; these prove *when*, which a real clock cannot show without
 * making the suite slow and flaky.
 */

import assert from 'node:assert/strict';
import { AiGenerationError } from '@zeddev/errors';
import { unitTest } from '@zeddev/testing';
import { FakeClock } from '@zeddev/time';
import { parseRetryAfter, runAttempts, safeProviderCode, type AttemptOutcome, type AttemptPolicy } from './attempts.ts';

function policy(clock: FakeClock, overrides: Partial<AttemptPolicy> = {}): AttemptPolicy {
  return { provider: 'gemini', operation: 'generate', maxAttempts: 3, timeoutMs: 1_000, clock, backoff: () => 10, ...overrides };
}

/** Let pending promise continuations run. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

unitTest('a Retry-After longer than the backoff is waited out in full before the next attempt', async () => {
  const clock = new FakeClock();
  const outcomes: AttemptOutcome<string>[] = [{ ok: false, status: 429, retryAfterMs: 5_000 }, { ok: true, value: 'done' }];
  let attempts = 0;
  const call = runAttempts(policy(clock), undefined, async () => {
    attempts += 1;
    return outcomes.shift()!;
  });

  await settle();
  assert.equal(attempts, 1);
  await clock.advance(4_999);
  await settle();
  assert.equal(attempts, 1, 'the provider asked for five seconds; the 10 ms backoff must not undercut it');
  await clock.advance(1);
  assert.equal(await call, 'done');
  assert.equal(attempts, 2);
});

unitTest('the backoff applies when it is longer than the Retry-After', async () => {
  const clock = new FakeClock();
  let attempts = 0;
  const call = runAttempts(policy(clock, { backoff: () => 3_000 }), undefined, async (): Promise<AttemptOutcome<string>> => {
    attempts += 1;
    return attempts === 1 ? { ok: false, status: 503, retryAfterMs: 1_000 } : { ok: true, value: 'done' };
  });
  await settle();
  await clock.advance(2_999);
  await settle();
  assert.equal(attempts, 1);
  await clock.advance(1);
  assert.equal(await call, 'done');
});

unitTest('the per-attempt timeout runs on the injected clock', async () => {
  const clock = new FakeClock();
  const call = runAttempts(policy(clock, { maxAttempts: 1 }), undefined, (signal) =>
    new Promise<AttemptOutcome<string>>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  );
  const outcome = call.then(
    () => assert.fail('expected a timeout'),
    (error: unknown) => error,
  );
  await settle();
  await clock.advance(1_000);
  const error = await outcome;
  assert.ok(error instanceof AiGenerationError);
  assert.equal(error.code, 'ai.timeout');
  assert.equal(clock.pendingTimers, 0, 'no timer outlives the call');
});

unitTest('Retry-After is read as delay-seconds or an HTTP date, and anything else is ignored', () => {
  const now = new Date('2026-09-19T12:00:00Z');
  assert.equal(parseRetryAfter('7', now), 7_000);
  assert.equal(parseRetryAfter('Sat, 19 Sep 2026 12:00:30 GMT', now), 30_000);
  assert.equal(parseRetryAfter('Sat, 19 Sep 2026 11:00:00 GMT', now), 0, 'a date in the past means now');
  assert.equal(parseRetryAfter('soon', now), undefined);
  assert.equal(parseRetryAfter(null, now), undefined);
});

unitTest('only code-shaped upstream values are kept, so an echoed message can never become a code', () => {
  assert.equal(safeProviderCode('RESOURCE_EXHAUSTED'), 'RESOURCE_EXHAUSTED');
  assert.equal(safeProviderCode('rate_limit_exceeded'), 'rate_limit_exceeded');
  assert.equal(safeProviderCode(429), '429');
  assert.equal(safeProviderCode('Invalid value at contents[0]: "my card is 4111"'), undefined);
  assert.equal(safeProviderCode('x'.repeat(65)), undefined);
  assert.equal(safeProviderCode(null), undefined);
});
