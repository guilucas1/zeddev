/**
 * Why these tests matter: the taxonomy's value is entirely in the *distinctions*
 * it preserves. A test suite that only checked "throwing works" would pass while
 * a refactor quietly merged `ConnectionRevokedError` into `TerminalTransportError`
 * and silently dropped a spec-required connection state transition. So the
 * assertions here are mostly about what is NOT equal to what.
 */

import assert from 'node:assert/strict';
import { specTest, unitTest } from '@zeddev/testing';
import {
  AiGenerationError,
  AuthenticationError,
  AuthorizationError,
  ConfigurationError,
  ConnectionRevokedError,
  DuplicateError,
  ERROR_KINDS,
  InternalError,
  MediaRetrievalError,
  OutsideServiceWindowError,
  TenantAccessError,
  TerminalTransportError,
  TransientTransportError,
  ValidationError,
  ZedError,
  isRetryable,
  toDiagnostic,
} from './index.ts';

specTest(
  'environment-portability.md',
  'AC7 clear configuration error',
  'ConfigurationError names every missing key, not just the first',
  () => {
    const error = new ConfigurationError([
      { key: 'DATABASE_URL', reason: 'required but not set' },
      { key: 'AI_API_KEY', reason: 'required but not set' },
      { key: 'PORT', reason: 'must be an integer' },
    ]);

    // Sorted so the report is stable across runs; an unstable list makes a
    // startup failure harder to diff between two deployments.
    assert.deepEqual(error.keys, ['AI_API_KEY', 'DATABASE_URL', 'PORT']);
    for (const key of ['AI_API_KEY', 'DATABASE_URL', 'PORT']) {
      assert.ok(error.message.includes(key), `message should identify ${key}`);
    }
    assert.equal(error.retryable, false);
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC2 missing secret fails startup clearly',
  'a missing secret produces the same fail-fast ConfigurationError as any other key',
  () => {
    const error = new ConfigurationError([{ key: 'WHATSAPP_APP_SECRET', reason: 'required but not set' }]);
    assert.equal(error.kind, 'configuration');
    assert.ok(error.message.includes('WHATSAPP_APP_SECRET'));
  },
);

specTest(
  'tenant-data-isolation.md',
  'AC9 cross-tenant identifier refused',
  'TenantAccessError records both the bound and the requested tenant for audit',
  () => {
    const error = new TenantAccessError({
      boundTenantId: 'tenant-b',
      requestedTenantId: 'tenant-a',
      resource: 'conversation',
    });
    assert.equal(error.kind, 'tenant_access');
    assert.equal(error.retryable, false);
    assert.equal(error.context['boundTenantId'], 'tenant-b');
    assert.equal(error.context['requestedTenantId'], 'tenant-a');
  },
);

specTest(
  'authentication-and-access.md',
  'AC3 no account enumeration',
  'AuthenticationError is identical whether or not the account exists',
  () => {
    // The taxonomy simply provides no place to record which case occurred, so a
    // future call site cannot leak the distinction even carelessly.
    const unknownAccount = new AuthenticationError();
    const wrongPassword = new AuthenticationError();
    assert.deepEqual(unknownAccount.toDiagnostic(), wrongPassword.toDiagnostic());
    assert.equal(unknownAccount.message, wrongPassword.message);
  },
);

specTest(
  'whatsapp-number-connection.md',
  'reconnecting vs error boundary',
  'transient and terminal transport failures are distinguishable and differ in retryability',
  () => {
    const transient = new TransientTransportError('upstream timeout', { code: 'http.timeout' });
    const terminal = new TerminalTransportError('bad request', { code: 'http.400' });

    assert.equal(isRetryable(transient), true, 'transient drives the reconnecting state');
    assert.equal(isRetryable(terminal), false, 'terminal drives the error state');
    assert.notEqual(transient.kind, terminal.kind);
  },
);

specTest(
  'message-delivery-reliability.md',
  'AC9 revocation drives a state transition',
  'ConnectionRevokedError is not caught by an instanceof TerminalTransportError handler',
  () => {
    const revoked = new ConnectionRevokedError({ tenantId: 't1', reason: 'authorization revoked' });

    // This is the assertion that protects the spec requirement. If revocation
    // were a subclass of TerminalTransportError, an existing handler for
    // terminal failures would swallow it and the connection would never
    // transition to `error` with a surfaced reason.
    assert.equal(revoked instanceof TerminalTransportError, false);
    assert.equal(revoked.kind, 'connection_revoked');
    assert.equal(revoked.context['reason'], 'authorization revoked');
  },
);

specTest(
  'fallback-response-behavior.md',
  'AI failure is distinct from delivery failure',
  'AiGenerationError is not a transport error, so fallback triggers on one and not the other',
  () => {
    const aiFailure = new AiGenerationError('provider returned no candidates', {
      code: 'ai.empty_response',
      provider: 'gemini',
    });
    const deliveryFailure = new TerminalTransportError('send rejected', { code: 'http.400' });

    assert.equal(aiFailure.kind, 'ai_generation');
    assert.equal(deliveryFailure.kind, 'terminal_transport');
    assert.equal(aiFailure instanceof TerminalTransportError, false);
    assert.equal(aiFailure.context['provider'], 'gemini');
  },
);

specTest(
  'message-delivery-reliability.md',
  'AC14/AC15 media retrieval has its own allowance',
  'MediaRetrievalError is retryable and carries its retry count',
  () => {
    const error = new MediaRetrievalError({ mediaId: 'media-1', retryCount: 3 });
    assert.equal(error.retryable, true);
    assert.equal(error.context['retryCount'], 3);
    assert.equal(error.kind, 'media_retrieval');
  },
);

specTest(
  'message-delivery-reliability.md',
  'AC10 outside 24h window is detected not silently failed',
  'OutsideServiceWindowError is a representable, recordable condition',
  () => {
    const error = new OutsideServiceWindowError({ tenantId: 't1', hoursSinceLastInbound: 30 });
    assert.equal(error.kind, 'outside_service_window');
    assert.equal(error.retryable, false, 'retrying cannot bring the reply back inside the window');
    assert.equal(error.context['hoursSinceLastInbound'], 30);
  },
);

specTest(
  'message-delivery-reliability.md',
  'AC4 redelivery recognised as already-seen',
  'DuplicateError identifies the external id without reprocessing',
  () => {
    const error = new DuplicateError({ resource: 'inbound_message', externalId: 'wamid.ABC' });
    assert.equal(error.kind, 'duplicate');
    assert.equal(error.context['externalId'], 'wamid.ABC');
  },
);

specTest(
  'message-delivery-reliability.md',
  'AC17 failure records carry operational info only',
  'a diagnostic never carries the error message, only codes and counts',
  () => {
    // Simulates the realistic hazard: a call site interpolates content into the
    // message. The diagnostic must not carry it regardless.
    const leaky = new TerminalTransportError('failed to send: my card number is 4111 1111 1111 1111', {
      code: 'http.400',
      context: { tenantId: 't1', retryCount: 2 },
    });

    const diagnostic = leaky.toDiagnostic();
    const serialized = JSON.stringify(diagnostic);

    assert.ok(!serialized.includes('4111'), 'diagnostic must not contain the message text');
    assert.ok(!('message' in diagnostic), 'diagnostic has no message field at all');
    assert.equal(diagnostic.code, 'http.400');
    assert.equal(diagnostic.context['retryCount'], 2);
  },
);

specTest(
  'operator-health-monitoring.md',
  'AC9 no conversation content in operator diagnostics',
  'a third-party error contributes only its type, never its message',
  () => {
    // Third-party libraries routinely embed the request body in error messages.
    const foreign = new TypeError('Cannot read property of {"text":"customer secret message"}');
    const diagnostic = toDiagnostic(foreign);

    assert.ok(!JSON.stringify(diagnostic).includes('customer secret message'));
    assert.equal(diagnostic.kind, 'internal');
    assert.equal(diagnostic.code, 'internal.unclassified');
    assert.equal(diagnostic.context['errorType'], 'TypeError');
  },
);

unitTest('unknown errors are treated as non-retryable (fail closed)', () => {
  // Retrying an unclassified error against a rate-limited free-tier API spends
  // allowance on calls that may never succeed, and delays surfacing the fault.
  assert.equal(isRetryable(new Error('boom')), false);
  assert.equal(isRetryable('a string'), false);
  assert.equal(isRetryable(undefined), false);
});

unitTest('a cause chain of ZedErrors is preserved in the diagnostic', () => {
  const root = new TransientTransportError('socket hang up', { code: 'net.econnreset' });
  const wrapper = new AiGenerationError('generation failed', {
    code: 'ai.transport',
    cause: root,
    provider: 'gemini',
  });

  const diagnostic = wrapper.toDiagnostic();
  assert.equal(diagnostic.cause?.code, 'net.econnreset');
  assert.equal(diagnostic.cause?.retryable, true);
});

unitTest('every error class reports a kind drawn from the closed vocabulary', () => {
  const instances: ZedError[] = [
    new ConfigurationError([{ key: 'K', reason: 'r' }]),
    new TenantAccessError({ boundTenantId: 't' }),
    new AuthenticationError(),
    new AuthorizationError({ principal: 'operator', action: 'read_transcript' }),
    new ValidationError([{ key: 'email', reason: 'invalid' }]),
    new TransientTransportError('m', { code: 'c' }),
    new TerminalTransportError('m', { code: 'c' }),
    new ConnectionRevokedError({ tenantId: 't', reason: 'r' }),
    new AiGenerationError('m', { code: 'c' }),
    new MediaRetrievalError({ mediaId: 'm', retryCount: 0 }),
    new OutsideServiceWindowError({ tenantId: 't', hoursSinceLastInbound: 25 }),
    new DuplicateError({ resource: 'r', externalId: 'e' }),
    new InternalError('m'),
  ];

  for (const instance of instances) {
    assert.ok(
      (ERROR_KINDS as readonly string[]).includes(instance.kind),
      `${instance.constructor.name} has kind "${instance.kind}" outside the closed vocabulary`,
    );
    // `name` is what appears in an unhandled rejection trace; a wrong one makes
    // production triage read the wrong class.
    assert.equal(instance.name, instance.constructor.name);
  }
});

unitTest('error context is frozen so it cannot be mutated into a leak after construction', () => {
  const error = new TerminalTransportError('m', { code: 'c', context: { tenantId: 't1' } });
  assert.throws(() => {
    (error.context as Record<string, unknown>)['transcript'] = 'customer message';
  }, TypeError);
});

unitTest('TransientTransportError carries an upstream backoff hint through to the diagnostic', () => {
  const error = new TransientTransportError('rate limited', { code: 'http.429', retryAfterMs: 5000 });
  assert.equal(error.retryAfterMs, 5000);
  assert.equal(error.toDiagnostic().context['retryAfterMs'], 5000);
});

unitTest('InternalError keeps a caller-supplied code rather than overwriting it', () => {
  // Regression guard: spreading defaults after the caller's options would silently
  // discard the specific code and make every internal failure look identical.
  assert.equal(new InternalError('m', { code: 'worker.crashed' }).code, 'worker.crashed');
  assert.equal(new InternalError('m').code, 'internal.error');
});
