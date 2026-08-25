/**
 * Why these tests matter: the fake clock is test infrastructure, and a subtly
 * wrong fake produces confidently wrong tests everywhere it is used. In
 * particular, burst aggregation depends on two timers racing (the quiet period
 * and the maximum turn extension), so the fake must fire timers in due-time
 * order and must move the clock *to* each timer's due time before firing it —
 * otherwise a burst test would prove nothing about real behavior.
 */

import assert from 'node:assert/strict';
import { unitTest } from '@zeddev/testing';
import { FakeClock, SystemClock } from './index.ts';

unitTest('FakeClock starts at a fixed instant so timestamps in tests are deterministic', () => {
  const clock = new FakeClock('2026-03-01T12:00:00.000Z');
  assert.equal(clock.now().toISOString(), '2026-03-01T12:00:00.000Z');
});

unitTest('advancing moves both wall and monotonic time by the same amount', async () => {
  const clock = new FakeClock('2026-03-01T12:00:00.000Z');
  const monotonicBefore = clock.monotonicMs();

  await clock.advance(90_000);

  assert.equal(clock.now().toISOString(), '2026-03-01T12:01:30.000Z');
  assert.equal(clock.monotonicMs() - monotonicBefore, 90_000);
});

unitTest('monotonic time does not start equal to wall time, so conflating them is visible', () => {
  // If the fake returned the same number for both, code that used the wrong one
  // would pass its tests and fail in production.
  const clock = new FakeClock('2026-03-01T12:00:00.000Z');
  assert.notEqual(clock.monotonicMs(), clock.now().getTime());
});

unitTest('a backwards wall-clock jump does not move monotonic time', () => {
  // Models an NTP correction. A backoff or burst window computed from wall time
  // would either fire immediately or hang; one computed monotonically is immune.
  const clock = new FakeClock('2026-03-01T12:00:00.000Z');
  const monotonicBefore = clock.monotonicMs();

  clock.setWallClock('2026-03-01T11:00:00.000Z');

  assert.equal(clock.now().toISOString(), '2026-03-01T11:00:00.000Z');
  assert.equal(clock.monotonicMs(), monotonicBefore);
});

unitTest('a timer fires only once its due time is reached', async () => {
  const clock = new FakeClock();
  let fired = false;
  clock.setTimer(5000, () => {
    fired = true;
  });

  await clock.advance(4999);
  assert.equal(fired, false);

  await clock.advance(1);
  assert.equal(fired, true);
  assert.equal(clock.pendingTimers, 0);
});

unitTest('timers fire in due-time order, not registration order', async () => {
  // The burst-aggregation case: a maximum-extension timer registered first must
  // still fire after a shorter quiet-period timer registered second.
  const clock = new FakeClock();
  const order: string[] = [];

  clock.setTimer(30_000, () => order.push('max-extension'));
  clock.setTimer(8_000, () => order.push('quiet-period'));
  clock.setTimer(15_000, () => order.push('middle'));

  await clock.advance(60_000);

  assert.deepEqual(order, ['quiet-period', 'middle', 'max-extension']);
});

unitTest('a timer observes the clock at its own due time, not at the end of the advance', async () => {
  // If the clock jumped straight to the end of the advance before firing, any
  // timestamp recorded by the callback would be wrong — and a transition history
  // built from those timestamps would be wrong with it.
  const clock = new FakeClock('2026-03-01T12:00:00.000Z');
  const observed: string[] = [];

  clock.setTimer(10_000, () => observed.push(clock.now().toISOString()));
  clock.setTimer(20_000, () => observed.push(clock.now().toISOString()));

  await clock.advance(60_000);

  assert.deepEqual(observed, ['2026-03-01T12:00:10.000Z', '2026-03-01T12:00:20.000Z']);
  assert.equal(clock.now().toISOString(), '2026-03-01T12:01:00.000Z');
});

unitTest('a cancelled timer does not fire', async () => {
  const clock = new FakeClock();
  let fired = false;
  const cancel = clock.setTimer(1000, () => {
    fired = true;
  });

  cancel();
  assert.equal(clock.pendingTimers, 0);

  await clock.advance(5000);
  assert.equal(fired, false);
});

unitTest('a timer scheduled from within a firing timer is honoured in the same advance', async () => {
  // Retry-with-backoff schedules the next attempt from inside the previous one.
  // If re-entrant scheduling were dropped, a backoff test would silently only
  // ever exercise the first attempt.
  const clock = new FakeClock();
  const fired: number[] = [];

  clock.setTimer(1000, () => {
    fired.push(1);
    clock.setTimer(1000, () => {
      fired.push(2);
      clock.setTimer(1000, () => fired.push(3));
    });
  });

  await clock.advance(5000);
  assert.deepEqual(fired, [1, 2, 3]);
});

unitTest('sleep resolves when time advances past its duration', async () => {
  const clock = new FakeClock();
  let resolved = false;
  const pending = clock.sleep(1000).then(() => {
    resolved = true;
  });

  await clock.advance(999);
  assert.equal(resolved, false);

  await clock.advance(1);
  await pending;
  assert.equal(resolved, true);
});

unitTest('sleep rejects when its abort signal fires, and cancels the underlying timer', async () => {
  // Shutdown must not be blocked by an in-flight backoff sleep.
  const clock = new FakeClock();
  const controller = new AbortController();
  const pending = clock.sleep(10_000, { signal: controller.signal });

  controller.abort(new Error('shutting down'));

  await assert.rejects(pending, /shutting down/);
  assert.equal(clock.pendingTimers, 0);
});

unitTest('sleep with an already-aborted signal rejects without scheduling anything', async () => {
  const clock = new FakeClock();
  const controller = new AbortController();
  controller.abort(new Error('already down'));

  await assert.rejects(clock.sleep(1000, { signal: controller.signal }), /already down/);
  assert.equal(clock.pendingTimers, 0);
});

unitTest('advancing by a negative duration is rejected rather than silently rewinding', async () => {
  // `advance` is async, so the guard surfaces as a rejection, not a synchronous
  // throw. Asserting the wrong one passes vacuously and leaks an unhandled
  // rejection into the next test.
  const clock = new FakeClock();
  await assert.rejects(clock.advance(-1), RangeError);
});

unitTest('SystemClock reports advancing monotonic time and a plausible wall clock', async () => {
  const clock = new SystemClock();
  const start = clock.monotonicMs();
  await clock.sleep(5);

  assert.ok(clock.monotonicMs() >= start, 'monotonic time must never decrease');
  assert.ok(Math.abs(clock.now().getTime() - Date.now()) < 5_000);
});

unitTest('SystemClock timers can be cancelled', async () => {
  const clock = new SystemClock();
  let fired = false;
  const cancel = clock.setTimer(5, () => {
    fired = true;
  });
  cancel();

  await clock.sleep(30);
  assert.equal(fired, false);
});
