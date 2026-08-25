/**
 * Tests for the access boundary between the two principal types.
 *
 * `authentication-and-access.md` is unusually insistent that these denials be
 * structural: the operator must be refused a transcript "through any surface,
 * including a diagnostic or support-tooling path" (AC15), and refused an
 * activation change or an offboarding "regardless of whether an interface control
 * exists for it" (AC16, AC17). A test that drove one HTTP route would prove
 * nothing about the next route somebody adds.
 *
 * So the tests below assert over the *whole* action table rather than over
 * examples. The last one is the important one: it fails if an action is added
 * without a decision about who holds it, which is the only way a new surface
 * could quietly acquire a permission nobody granted it.
 */

import assert from 'node:assert/strict';
import { AuthorizationError } from '@zeddev/errors';
import { specTest, unitTest } from '@zeddev/testing';
import {
  ACTION_PRINCIPALS,
  ACTIONS,
  authorize,
  permits,
  principalId,
  PRINCIPAL_TYPES,
  requireClient,
  requireOperator,
  type Action,
  type ClientPrincipal,
  type OperatorPrincipal,
} from './principals.ts';

const client: ClientPrincipal = {
  type: 'client',
  accountId: '11111111-1111-4111-8111-111111111111',
  tenantId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
};

const operator: OperatorPrincipal = {
  type: 'operator',
  operatorId: '44444444-4444-4444-8444-444444444444',
  sessionId: '55555555-5555-4555-8555-555555555555',
};

specTest(
  'authentication-and-access.md',
  'AC16 the operator cannot change a client’s bot activation state through any surface',
  'the operator is refused every client-held action, not merely the ones with a UI',
  () => {
    const clientActions = ACTIONS.filter((action) => ACTION_PRINCIPALS[action] === 'client');
    assert.notEqual(clientActions.length, 0);
    for (const action of clientActions) {
      assert.equal(permits(operator, action), false, `operator was permitted ${action}`);
      assert.throws(() => authorize(operator, action), AuthorizationError);
    }
    // Named explicitly, because these three are the ones the spec calls out.
    for (const action of ['tenant.activation.change', 'tenant.offboard', 'tenant.delete'] as const) {
      assert.equal(permits(operator, action), false);
    }
  },
);

specTest(
  'authentication-and-access.md',
  'AC15 the operator is denied conversation content through any path',
  'reading a transcript or conversation memory is a client-only action',
  () => {
    for (const action of ['conversation.read', 'conversation.memory.read'] as const) {
      assert.equal(ACTION_PRINCIPALS[action], 'client');
      assert.throws(() => requireOperator(operator, action), AuthorizationError);
      assert.equal(requireClient(client, action).tenantId, client.tenantId);
    }
  },
);

specTest(
  'authentication-and-access.md',
  'AC22 a client credential is insufficient for operator access',
  'a client is refused every operator-held action',
  () => {
    const operatorActions = ACTIONS.filter((action) => ACTION_PRINCIPALS[action] === 'operator');
    assert.notEqual(operatorActions.length, 0);
    for (const action of operatorActions) {
      assert.equal(permits(client, action), false, `client was permitted ${action}`);
      assert.throws(() => authorize(client, action), AuthorizationError);
    }
  },
);

specTest(
  'authentication-and-access.md',
  'AC14 an authenticated operator may read per-tenant health and aggregated metrics',
  'the operator holds the platform-wide read actions',
  () => {
    for (const action of [
      'platform.health.read',
      'platform.metrics.read',
      'platform.notifications.read',
    ] as const) {
      assert.doesNotThrow(() => requireOperator(operator, action));
    }
  },
);

unitTest('every action names exactly one principal type, and it is a real one', () => {
  // The guard that makes this table load-bearing: a new action cannot be added
  // without deciding who holds it, and cannot be held by an invented type.
  for (const action of ACTIONS) {
    const holder = ACTION_PRINCIPALS[action];
    assert.equal(
      PRINCIPAL_TYPES.includes(holder),
      true,
      `${action} names a principal type that does not exist: ${holder}`,
    );
    const holders = PRINCIPAL_TYPES.filter((type) =>
      permits(type === 'client' ? client : operator, action as Action),
    );
    assert.deepEqual(holders, [holder], `${action} is held by ${holders.length} principal types`);
  }
});

unitTest('there is no action that both principal types may perform', () => {
  // Stated separately from the table check because it is the property that
  // matters: an action reachable by both is an action where the two identity
  // spaces overlap, which authentication-and-access.md forbids outright.
  const shared = ACTIONS.filter((action) => permits(client, action) && permits(operator, action));
  assert.deepEqual(shared, []);
});

unitTest('an access record identifies a principal by the right identifier', () => {
  assert.equal(principalId(client), client.accountId);
  assert.equal(principalId(operator), operator.operatorId);
});

unitTest('an authorization failure carries the principal type, never the principal id', () => {
  // AuthorizationError's context reaches logs. A principal id there would be a
  // per-request identifier in an operator-visible surface for no diagnostic gain.
  try {
    authorize(operator, 'tenant.offboard');
    assert.fail('expected a refusal');
  } catch (error) {
    assert.ok(error instanceof AuthorizationError);
    assert.deepEqual(error.context, { principal: 'operator', action: 'tenant.offboard' });
  }
});
