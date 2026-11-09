/**
 * The rules for reading the counts back. Pure, so they need no database.
 */

import assert from 'node:assert/strict';
import { ValidationError } from '@zeddev/errors';
import { specTest, unitTest } from '@zeddev/testing';
import {
  assessHealth,
  METRIC_RETENTION_DAYS,
  NO_METRICS,
  parseMetricSelection,
  resolveMetricRange,
  summarizeMetrics,
  type MetricTotals,
} from './metrics.ts';

const NOW = new Date('2026-06-15T10:20:30.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function totals(overrides: Partial<MetricTotals>): MetricTotals {
  return { ...NO_METRICS, ...overrides };
}

function parsed(body: Record<string, unknown>): { selection: ReturnType<typeof parseMetricSelection>; issues: { key: string }[] } {
  const issues: { key: string; reason: string }[] = [];
  return { selection: parseMetricSelection(body, issues), issues };
}

specTest(
  'operator-health-monitoring.md',
  'AC4 a selected time window sets what the metrics cover',
  'each preset ends with the current hour and spans its whole length',
  () => {
    const day = resolveMetricRange({ kind: 'window', window: '24h' }, NOW);
    assert.equal(day.to.toISOString(), '2026-06-15T11:00:00.000Z');
    assert.equal(day.to.getTime() - day.from.getTime(), 24 * HOUR);
    assert.equal(resolveMetricRange({ kind: 'window', window: '7d' }, NOW).from.toISOString(), '2026-06-08T11:00:00.000Z');
    assert.equal(resolveMetricRange({ kind: 'window', window: '30d' }, NOW).from.toISOString(), '2026-05-16T11:00:00.000Z');
    assert.equal(resolveMetricRange({ kind: 'window', window: '30d' }, NOW).available, true);
  },
);

specTest(
  'operator-health-monitoring.md',
  'AC7 historical metrics within the retention window are retrievable',
  'a range widens to whole hours, and one at the very edge of retention is still available',
  () => {
    const range = resolveMetricRange(
      { kind: 'range', from: new Date('2026-06-01T08:30:00Z'), to: new Date('2026-06-02T09:10:00Z') },
      NOW,
    );
    assert.equal(range.from.toISOString(), '2026-06-01T08:00:00.000Z');
    assert.equal(range.to.toISOString(), '2026-06-02T10:00:00.000Z');
    assert.equal(range.available, true);

    const edge = new Date(Date.UTC(2026, 5, 15, 10) - METRIC_RETENTION_DAYS * DAY);
    assert.equal(resolveMetricRange({ kind: 'range', from: edge, to: NOW }, NOW).available, true);
  },
);

specTest(
  'operator-health-monitoring.md',
  'AC8 historical metrics outside the retention window are reported unavailable',
  'a range reaching even one hour past retention is unavailable as a whole',
  () => {
    const justPast = new Date(Date.UTC(2026, 5, 15, 9) - METRIC_RETENTION_DAYS * DAY);
    const range = resolveMetricRange({ kind: 'range', from: justPast, to: NOW }, NOW);
    assert.equal(range.available, false);
    assert.equal(range.retainedSince.getTime(), Date.UTC(2026, 5, 15, 10) - METRIC_RETENTION_DAYS * DAY);
  },
);

unitTest('a range cannot run past the current hour, and one wholly in the future is refused', () => {
  const clipped = resolveMetricRange({ kind: 'range', from: new Date('2026-06-15T01:00:00Z'), to: new Date('2027-01-01T00:00:00Z') }, NOW);
  assert.equal(clipped.to.toISOString(), '2026-06-15T11:00:00.000Z');
  assert.throws(
    () => resolveMetricRange({ kind: 'range', from: new Date('2026-07-01T00:00:00Z'), to: new Date('2026-07-02T00:00:00Z') }, NOW),
    ValidationError,
  );
  assert.throws(
    () => resolveMetricRange({ kind: 'range', from: new Date('2026-06-02T00:00:00Z'), to: new Date('2026-06-01T00:00:00Z') }, NOW),
    ValidationError,
  );
});

unitTest('a selection is a preset or a range, never both and never something unknown', () => {
  assert.deepEqual(parsed({}).selection, { kind: 'window', window: '24h' });
  assert.deepEqual(parsed({ window: '7d' }).selection, { kind: 'window', window: '7d' });
  assert.deepEqual(parsed({ window: '1y' }).issues.map((i) => i.key), ['window']);
  assert.deepEqual(parsed({ window: 'toString' }).issues.map((i) => i.key), ['window']);
  assert.deepEqual(parsed({ window: '7d', from: '2026-01-01' }).issues.map((i) => i.key), ['window']);
  assert.deepEqual(parsed({ from: '2026-01-01' }).issues.map((i) => i.key), ['to']);
  assert.deepEqual(parsed({ from: 'yesterday', to: 5 }).issues.map((i) => i.key), ['from', 'to']);
  assert.deepEqual(parsed({ from: '2026-01-01', to: '2026-01-02T00:00:00Z' }).issues, []);
});

specTest(
  'operator-health-monitoring.md',
  'AC11 zero traffic displays as zero or no activity',
  'no traffic is zero counts and no rate, rather than a division by zero',
  () => {
    const summary = summarizeMetrics(NO_METRICS);
    assert.equal(summary.noActivity, true);
    assert.equal(summary.messagesReceived, 0);
    assert.equal(summary.errorRate, null);
    assert.equal(summary.responseFailureRate, null);
    assert.equal(summary.deliveryFailureRate, null);
    assert.equal(summary.averageResponseMs, null);
    assert.equal(summarizeMetrics(totals({ messagesReceived: 1 })).noActivity, false);
  },
);

unitTest('the error rate counts both kinds of failure over both chances, and stays within one', () => {
  const summary = summarizeMetrics(
    totals({ turnsAnswered: 10, failedResponses: 2, messagesSent: 7, failedDeliveries: 3, expiredDeliveries: 5, responsesTimed: 4, responseMsTotal: 4_002 }),
  );
  assert.equal(summary.errorRate, 5 / 20);
  assert.equal(summary.responseFailureRate, 2 / 10);
  assert.equal(summary.deliveryFailureRate, 3 / 10);
  assert.equal(summary.averageResponseMs, 1_001);

  const everything = summarizeMetrics(totals({ turnsAnswered: 4, failedResponses: 4, failedDeliveries: 4 }));
  assert.equal(everything.errorRate, 1);
});

unitTest('a delivery that missed the 24-hour window is reported but is not an error', () => {
  const summary = summarizeMetrics(totals({ turnsAnswered: 10, messagesSent: 5, expiredDeliveries: 5 }));
  assert.equal(summary.expiredDeliveries, 5);
  assert.equal(summary.errorRate, 0);
});

const QUIET_HISTORY = totals({ turnsAnswered: 100, messagesSent: 100, responsesTimed: 100, responseMsTotal: 100 * 2_000 });

unitTest('an error rate past the limit is flagged, but not on too few attempts to mean anything', () => {
  const bad = totals({ turnsAnswered: 10, failedResponses: 5, messagesSent: 5 });
  assert.equal(assessHealth(bad, NO_METRICS).elevatedErrorRate, true);
  const tiny = totals({ turnsAnswered: 2, failedResponses: 2 });
  assert.equal(assessHealth(tiny, NO_METRICS).elevatedErrorRate, false);
});

unitTest('a rate well above the tenant’s own normal is flagged even below the limit', () => {
  const worse = totals({ turnsAnswered: 50, failedResponses: 5, messagesSent: 50 });
  const healthy = assessHealth(worse, QUIET_HISTORY);
  assert.equal(healthy.elevatedErrorRate, true);

  // The same rate is the normal for this tenant, so it says nothing.
  const usual = totals({ turnsAnswered: 500, failedResponses: 50, messagesSent: 500 });
  assert.equal(assessHealth(worse, usual).elevatedErrorRate, false);
});

unitTest('a first failure against a spotless history is not an alarm', () => {
  const single = totals({ turnsAnswered: 50, failedResponses: 1, messagesSent: 49 });
  assert.equal(assessHealth(single, QUIET_HISTORY).elevatedErrorRate, false);
});

unitTest('a slow period is flagged against the tenant’s own normal and against the absolute limit', () => {
  const twiceAsSlow = totals({ responsesTimed: 20, responseMsTotal: 20 * 4_000 });
  assert.equal(assessHealth(twiceAsSlow, QUIET_HISTORY).degradedResponseTime, true);
  assert.equal(assessHealth(twiceAsSlow, NO_METRICS).degradedResponseTime, false, 'no history to compare with');

  const alwaysAwful = totals({ responsesTimed: 20, responseMsTotal: 20 * 400_000 });
  assert.equal(assessHealth(alwaysAwful, alwaysAwful).degradedResponseTime, true);

  const fewSamples = totals({ responsesTimed: 2, responseMsTotal: 2 * 400_000 });
  assert.equal(assessHealth(fewSamples, QUIET_HISTORY).degradedResponseTime, false);
});
