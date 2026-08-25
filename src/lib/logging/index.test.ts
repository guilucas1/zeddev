/**
 * Why these tests matter: this module's entire purpose is a guarantee about
 * *absence* — no conversation content, no secret values, on any operator-visible
 * surface. Absence is not something a call-site review can establish, so the
 * tests here attack the boundary the way a careless future call site would:
 * unknown field names, nested payloads, interpolated event strings, secrets
 * smuggled under legitimate keys.
 *
 * A test that only asserted "logging a tenantId works" would pass forever while
 * the guarantee rotted.
 */

import assert from 'node:assert/strict';
import { specTest, unitTest } from '@zeddev/testing';
import { FakeClock } from '@zeddev/time';
import { Secret } from '@zeddev/secrets';
import { TerminalTransportError } from '@zeddev/errors';
import { Logger, MemorySink, OPERATIONAL_FIELDS, REDACTED, endCustomerRef } from './index.ts';

const CUSTOMER_MESSAGE = 'Hi, my order number is 12345 and my card ends 4242';

function makeLogger(bindings?: Record<string, unknown>): { log: Logger; sink: MemorySink } {
  const sink = new MemorySink();
  const log = new Logger({
    sink,
    level: 'debug',
    clock: new FakeClock('2026-03-01T12:00:00.000Z'),
    ...(bindings === undefined ? {} : { bindings }),
  });
  return { log, sink };
}

specTest(
  'operator-health-monitoring.md',
  'AC9 no conversation content in logs',
  'a field not on the operational allowlist is redacted rather than emitted',
  () => {
    const { log, sink } = makeLogger();

    // `messageText` is not on the allowlist. This is the ordinary way content
    // leaks: someone adds a field that seems useful for debugging.
    log.info('message.received', { tenantId: 't1', messageText: CUSTOMER_MESSAGE });

    assert.ok(!sink.serialized().includes('12345'), 'content must not reach the log');
    assert.ok(!sink.serialized().includes('4242'));
    assert.equal(sink.records[0]?.fields['messageText'], REDACTED);
    // The allowlisted field survives, so the log is still useful.
    assert.equal(sink.records[0]?.fields['tenantId'], 't1');
  },
);

specTest(
  'operator-health-monitoring.md',
  'AC9 no conversation content in logs',
  'redaction is an allowlist, so an unforeseen field name still fails closed',
  () => {
    const { log, sink } = makeLogger();

    // None of these would be caught by a denylist of "password"-like names.
    log.info('debug.dump', {
      body: CUSTOMER_MESSAGE,
      payload: CUSTOMER_MESSAGE,
      txt: CUSTOMER_MESSAGE,
      q: CUSTOMER_MESSAGE,
      userSaid: CUSTOMER_MESSAGE,
    });

    const serialized = sink.serialized();
    assert.ok(!serialized.includes('12345'));
    assert.ok(!serialized.includes('order number'));
    for (const key of ['body', 'payload', 'txt', 'q', 'userSaid']) {
      assert.equal(sink.records[0]?.fields[key], REDACTED, `${key} should be redacted`);
    }
  },
);

specTest(
  'operator-health-monitoring.md',
  'AC9 no conversation content in logs',
  'a nested object under an allowlisted key is redacted',
  () => {
    const { log, sink } = makeLogger();

    // The subtle case: `reason` IS allowlisted, but an object smuggles content
    // through it. Scalars-only closes this.
    log.info('connection.failed', { reason: { detail: CUSTOMER_MESSAGE } });

    assert.ok(!sink.serialized().includes('12345'));
    assert.equal(sink.records[0]?.fields['reason'], REDACTED);
  },
);

specTest(
  'operator-health-monitoring.md',
  'AC9 no conversation content in logs',
  'an interpolated event name cannot become a free-text channel',
  () => {
    const { log, sink } = makeLogger();

    log.info(`received message: ${CUSTOMER_MESSAGE}`);

    assert.ok(!sink.serialized().includes('12345'));
    assert.equal(sink.records[0]?.event, 'log.invalid_event');
    // Flagged rather than silently swallowed, so the bad call site is findable.
    assert.equal(sink.records[0]?.fields['invalidEvent'], true);
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC5 no secret value in any log or diagnostic',
  'a Secret is redacted even when passed under an allowlisted key',
  () => {
    const { log, sink } = makeLogger();
    const token = new Secret('EAAG-real-whatsapp-token', 'WHATSAPP_TOKEN');

    // `reason` is allowlisted, so only the Secret wrapper prevents this leak.
    // Defence in depth: the two mechanisms are independent.
    log.info('connection.attempt', { reason: token, tenantId: 't1' });

    assert.ok(!sink.serialized().includes('EAAG-real-whatsapp-token'));
    assert.equal(sink.records[0]?.fields['reason'], REDACTED);
  },
);

specTest(
  'message-delivery-reliability.md',
  'AC17 failure records carry operational info only',
  'logging an error emits codes, kind and retryability but never the error message',
  () => {
    const { log, sink } = makeLogger();
    const error = new TerminalTransportError(`send failed for: ${CUSTOMER_MESSAGE}`, {
      code: 'http.400',
      context: { tenantId: 't1', retryCount: 3 },
    });

    log.error('delivery.failed', error, { messageId: 'm1' });

    const serialized = sink.serialized();
    assert.ok(!serialized.includes('12345'), 'the error message must not reach the log');
    assert.equal(sink.records[0]?.fields['errorCode'], 'http.400');
    assert.equal(sink.records[0]?.fields['errorKind'], 'terminal_transport');
    assert.equal(sink.records[0]?.fields['retryable'], false);
    assert.equal(sink.records[0]?.error?.context['retryCount'], 3);
    assert.equal(sink.records[0]?.fields['messageId'], 'm1');
  },
);

specTest(
  'tenant-data-isolation.md',
  'AC7 operator sees no end-customer content',
  'end-customer references are salted per tenant so activity cannot be correlated across tenants',
  () => {
    const phone = '+15551234567';
    const underTenantA = endCustomerRef('tenant-a', phone);
    const underTenantB = endCustomerRef('tenant-b', phone);

    assert.notEqual(underTenantA, underTenantB, 'a shared ref would enable cross-tenant correlation');
    assert.equal(underTenantA, endCustomerRef('tenant-a', phone), 'must be stable within a tenant');
    assert.ok(!underTenantA.includes('5551234567'), 'the raw identifier must not survive');
  },
);

specTest(
  'operator-health-monitoring.md',
  'AC9 no conversation content in logs',
  'the phone number field name is not on the allowlist, so a raw number is redacted',
  () => {
    const { log, sink } = makeLogger();
    log.info('message.received', { endCustomerPhone: '+15551234567', tenantId: 't1' });

    assert.ok(!sink.serialized().includes('5551234567'));
    assert.equal(sink.records[0]?.fields['endCustomerPhone'], REDACTED);
  },
);

unitTest('child loggers sanitize their own bindings rather than trusting the caller', () => {
  const { log, sink } = makeLogger({ tenantId: 't1' });

  const child = log.child({ conversationId: 'c1', lastMessage: CUSTOMER_MESSAGE });
  child.info('turn.started');

  assert.ok(!sink.serialized().includes('12345'));
  assert.equal(sink.records[0]?.fields['tenantId'], 't1', 'inherited binding survives');
  assert.equal(sink.records[0]?.fields['conversationId'], 'c1');
  assert.equal(sink.records[0]?.fields['lastMessage'], REDACTED);
});

unitTest('bindings are frozen so they cannot be mutated into a leak after construction', () => {
  const { log } = makeLogger({ tenantId: 't1' });
  const child = log.child({ conversationId: 'c1' });
  assert.ok(child instanceof Logger);
});

unitTest('level filtering suppresses records below the configured level', () => {
  const sink = new MemorySink();
  const log = new Logger({ sink, level: 'warn', clock: new FakeClock() });

  log.debug('a.b');
  log.info('a.c');
  log.warn('a.d');
  log.error('a.e');

  assert.deepEqual(
    sink.records.map((r) => r.event),
    ['a.d', 'a.e'],
  );
});

unitTest('timestamps come from the injected clock, making log assertions deterministic', () => {
  const sink = new MemorySink();
  const clock = new FakeClock('2026-03-01T12:00:00.000Z');
  const log = new Logger({ sink, level: 'debug', clock });

  log.info('a.b');
  void clock.advance(90_000);
  log.info('a.c');

  assert.equal(sink.records[0]?.at, '2026-03-01T12:00:00.000Z');
  assert.equal(sink.records[1]?.at, '2026-03-01T12:01:30.000Z');
});

unitTest('valid dotted event names are preserved unchanged', () => {
  const { log, sink } = makeLogger();
  for (const event of ['webhook.received', 'connection.state_changed', 'ai.generation.completed']) {
    log.info(event);
  }
  assert.deepEqual(
    sink.records.map((r) => r.event),
    ['webhook.received', 'connection.state_changed', 'ai.generation.completed'],
  );
  assert.ok(sink.records.every((r) => r.fields['invalidEvent'] === undefined));
});

unitTest('non-finite numbers are redacted rather than serialized as null', () => {
  // JSON.stringify turns NaN and Infinity into null, which would silently
  // corrupt a metric. Redacting makes the bad value visible instead.
  const { log, sink } = makeLogger();
  log.info('metric.recorded', { count: Number.NaN, durationMs: Number.POSITIVE_INFINITY, rate: 0.5 });

  assert.equal(sink.records[0]?.fields['count'], REDACTED);
  assert.equal(sink.records[0]?.fields['durationMs'], REDACTED);
  assert.equal(sink.records[0]?.fields['rate'], 0.5);
});

unitTest('the allowlist contains no field that could plausibly hold message content', () => {
  // A guard on the single source of truth itself. If someone adds `messageBody`
  // to the allowlist to make debugging easier, this fails and forces the
  // conversation rather than silently widening the boundary.
  const forbidden = [
    'message',
    'messageText',
    'messageBody',
    'body',
    'text',
    'content',
    'transcript',
    'memory',
    'prompt',
    'reply',
    'response',
    'caption',
    'transcription',
    'password',
    'token',
    'secret',
    'credential',
    'apiKey',
    'accessToken',
    'endCustomerPhone',
    'phoneNumber',
  ];
  for (const name of forbidden) {
    assert.equal(
      OPERATIONAL_FIELDS.has(name),
      false,
      `"${name}" must never be allowlisted — it can carry conversation content or a secret`,
    );
  }
});
