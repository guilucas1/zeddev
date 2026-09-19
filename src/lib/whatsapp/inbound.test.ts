/**
 * Inbound messages below the HTTP layer: authenticity, parsing, attribution,
 * duplicate suppression, and ordering.
 *
 * The signature and parser tests are pure. The rest runs against a real
 * PostgreSQL, because what is being asserted is the database's behaviour: that a
 * redelivered message inserts nothing, that the route disappears on *any* move to
 * `disconnected` (including one that bypasses this library), and that the inbound
 * scope — which crosses tenants by necessity — cannot read a single stored
 * message.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe } from 'node:test';
import { withIdentityScope, withInboundScope, withPlatformScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { ConflictError, ValidationError } from '@zeddev/errors';
import { migrateToLatest } from '@zeddev/schema';
import { Secret } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import { transitionConnection } from './connection.ts';
import {
  assignPhoneNumber,
  attributeInboundNumber,
  INBOUND_MESSAGE_TYPES,
  listInboundMessages,
  parseWebhookNotification,
  readInboundMessage,
  readPhoneNumber,
  recordInboundMessage,
  recordInboundRejection,
  verifyWebhookSignature,
  type InboundMessage,
} from './inbound.ts';

const APP_SECRET = new Secret<string>('test-app-secret-0123456789', 'WHATSAPP_APP_SECRET');

function sign(body: Buffer, secret: string = APP_SECRET.expose()): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** A notification in the upstream's envelope. */
function notification(phoneNumberId: string, messages: unknown[], extra: Record<string, unknown> = {}): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1029384756',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Pat' }, wa_id: '15557654321' }],
              messages,
              ...extra,
            },
          },
        ],
      },
    ],
  };
}

function textMessage(id: string, body: string, timestamp = '1760000000', from = '15557654321'): unknown {
  return { from, id, timestamp, type: 'text', text: { body } };
}

// ---------------------------------------------------------------------------
// Authenticity
// ---------------------------------------------------------------------------

specTest(
  'message-delivery-reliability.md',
  'AC2 a notification failing authenticity verification is rejected',
  'only a signature made with the app secret over the exact bytes received verifies',
  () => {
    const body = Buffer.from(JSON.stringify(notification('100200300', [textMessage('wamid.A', 'hi')])));
    assert.equal(verifyWebhookSignature(body, sign(body), APP_SECRET), 'valid');
    assert.equal(verifyWebhookSignature(body, sign(body).toUpperCase().replace('SHA256=', 'sha256='), APP_SECRET), 'valid');
    // Another key, a tampered body, a truncated or foreign-format header.
    assert.equal(verifyWebhookSignature(body, sign(body, 'some-other-secret-value'), APP_SECRET), 'signature_invalid');
    const tampered = Buffer.from(body.toString('utf8').replace('hi', 'ho'));
    assert.equal(verifyWebhookSignature(tampered, sign(body), APP_SECRET), 'signature_invalid');
    assert.equal(verifyWebhookSignature(body, sign(body).slice(0, -2), APP_SECRET), 'signature_invalid');
    assert.equal(verifyWebhookSignature(body, `sha1=${'0'.repeat(40)}`, APP_SECRET), 'signature_invalid');
    assert.equal(verifyWebhookSignature(body, undefined, APP_SECRET), 'signature_missing');
    assert.equal(verifyWebhookSignature(body, '  ', APP_SECRET), 'signature_missing');
  },
);

unitTest('the signature covers the raw bytes, not a re-serialisation of them', () => {
  // Same JSON value, different bytes. A verifier that parsed and re-serialised
  // would treat these as the same notification; the sender signed only one.
  const spaced = Buffer.from('{ "object": "whatsapp_business_account", "entry": [] }');
  const compact = Buffer.from(JSON.stringify(JSON.parse(spaced.toString('utf8'))));
  assert.equal(verifyWebhookSignature(spaced, sign(spaced), APP_SECRET), 'valid');
  assert.equal(verifyWebhookSignature(compact, sign(spaced), APP_SECRET), 'signature_invalid');
});

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

unitTest('text, image, audio, and other types are normalised into the platform vocabulary', () => {
  const parsed = parseWebhookNotification(
    notification('100200300', [
      textMessage('wamid.T', 'Do you open on Sundays?'),
      {
        from: '15557654321',
        id: 'wamid.I',
        timestamp: '1760000001',
        type: 'image',
        image: { id: '5550001', mime_type: 'image/jpeg', sha256: 'x', caption: 'this one' },
      },
      {
        from: '15557654321',
        id: 'wamid.V',
        timestamp: '1760000002',
        type: 'audio',
        audio: { id: '5550002', mime_type: 'audio/ogg; codecs=opus', voice: true },
      },
      { from: '15557654321', id: 'wamid.S', timestamp: '1760000003', type: 'sticker', sticker: { id: '5550003' } },
    ]),
  );
  assert.deepEqual(parsed.malformed, []);
  assert.equal(parsed.batches.length, 1);
  const [text, image, audio, sticker] = parsed.batches[0]!.messages;
  assert.equal(parsed.batches[0]!.phoneNumberId, '100200300');
  assert.deepEqual(text, {
    externalId: 'wamid.T',
    customerId: '15557654321',
    upstreamType: 'text',
    sentAt: new Date(1_760_000_000_000),
    type: 'text',
    content: { text: 'Do you open on Sundays?' },
  });
  assert.deepEqual(image?.content, { mediaId: '5550001', mimeType: 'image/jpeg', caption: 'this one' });
  // The codec parameter is dropped; the provider port keys on the bare type.
  assert.deepEqual(audio?.content, { mediaId: '5550002', mimeType: 'audio/ogg', voice: true });
  assert.equal(sticker?.type, 'unsupported');
  assert.equal(sticker?.upstreamType, 'sticker');
  assert.deepEqual(sticker?.content, {});
});

unitTest('an unreadable message is set aside and counted, and its readable neighbours still go through', () => {
  const parsed = parseWebhookNotification(
    notification('100200300', [
      textMessage('wamid.ok', 'fine'),
      textMessage('wamid.bad-from', 'x', '1760000000', '+1 555'),
      { from: '15557654321', id: 'wamid.no-body', timestamp: '1760000000', type: 'text' },
      textMessage('wamid.bad-time', 'x', 'yesterday'),
    ]),
  );
  assert.deepEqual(
    parsed.batches[0]!.messages.map((message) => message.externalId),
    ['wamid.ok'],
  );
  assert.deepEqual(parsed.malformed, [{ reason: 'malformed', phoneNumberId: '100200300', messageCount: 3 }]);
});

unitTest('a notification that is not a WhatsApp envelope, or names no receiving number, is malformed', () => {
  assert.deepEqual(parseWebhookNotification({ object: 'page', entry: [] }).malformed, [
    { reason: 'malformed', phoneNumberId: null, messageCount: 0 },
  ]);
  assert.deepEqual(parseWebhookNotification('nope').malformed, [
    { reason: 'malformed', phoneNumberId: null, messageCount: 0 },
  ]);
  const noNumber = parseWebhookNotification(notification('not-a-number', [textMessage('wamid.A', 'hi')]));
  assert.deepEqual(noNumber.batches, []);
  assert.deepEqual(noNumber.malformed, [{ reason: 'malformed', phoneNumberId: null, messageCount: 1 }]);
});

unitTest('delivery receipts and non-message changes are not messages', () => {
  const parsed = parseWebhookNotification(
    notification('100200300', [], { statuses: [{ id: 'wamid.out', status: 'delivered' }] }),
  );
  assert.deepEqual(parsed.batches, []);
  assert.deepEqual(parsed.malformed, []);
  assert.equal(parsed.statusCount, 1);
  const other = parseWebhookNotification({
    object: 'whatsapp_business_account',
    entry: [{ id: '1', changes: [{ field: 'account_update', value: { event: 'x' } }] }],
  });
  assert.deepEqual(other, { batches: [], malformed: [], statusCount: 0 });
});

unitTest('a NUL in end-customer text is removed rather than making the message unstorable', () => {
  const nul = String.fromCharCode(0);
  const parsed = parseWebhookNotification(notification('100200300', [textMessage('wamid.N', `a${nul}b`)]));
  assert.deepEqual(parsed.batches[0]!.messages[0]!.content, { text: 'ab' });
});

// ---------------------------------------------------------------------------
// Against the database
// ---------------------------------------------------------------------------

describe('inbound messages', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let counter = 0;
  let numberCounter = 700_000_000;

  async function newTenant(): Promise<string> {
    counter += 1;
    return withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Inbound Deli ${counter}`],
      );
      return created.rows[0]!.id;
    });
  }

  /** A tenant whose number is routed and connected; returns its number id. */
  async function connectedTenant(): Promise<{ tenant: string; phoneNumberId: string }> {
    const tenant = await newTenant();
    numberCounter += 1;
    const phoneNumberId = String(numberCounter);
    await withTenant(pool, tenant, async (tx) => {
      await transitionConnection(tx, 'connecting');
      await assignPhoneNumber(tx, phoneNumberId);
      await transitionConnection(tx, 'connected');
    });
    return { tenant, phoneNumberId };
  }

  function message(externalId: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
    return {
      externalId,
      customerId: '15557654321',
      type: 'text',
      upstreamType: 'text',
      content: { text: `body of ${externalId}` },
      sentAt: new Date(1_760_000_000_000),
      ...overrides,
    };
  }

  before(async () => {
    db = await createTestDatabase('whatsapp_inbound');
    pool = db.pool;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  specTest(
    'message-delivery-reliability.md',
    'AC3 a notification that cannot be matched to a tenant is rejected',
    'a receiving number is attributed to the tenant it is routed to, and an unrouted number to nobody',
    async () => {
      const a = await connectedTenant();
      const b = await connectedTenant();
      assert.equal(await attributeInboundNumber(pool, a.phoneNumberId), a.tenant);
      assert.equal(await attributeInboundNumber(pool, b.phoneNumberId), b.tenant);
      assert.equal(await attributeInboundNumber(pool, '999999999999'), undefined);
      assert.equal(await attributeInboundNumber(pool, 'not digits'), undefined);
    },
  );

  unitTest('a number is assigned only while connecting, and only to one tenant', async () => {
    const tenant = await newTenant();
    await assert.rejects(
      withTenant(pool, tenant, (tx) => assignPhoneNumber(tx, '810000001')),
      (error: unknown) => error instanceof ConflictError && error.code === 'whatsapp.number.not_connecting',
    );
    await assert.rejects(
      withTenant(pool, tenant, (tx) => assignPhoneNumber(tx, '+1 555')),
      ValidationError,
    );

    const owner = await connectedTenant();
    await withTenant(pool, tenant, (tx) => transitionConnection(tx, 'connecting'));
    await assert.rejects(
      withTenant(pool, tenant, (tx) => assignPhoneNumber(tx, owner.phoneNumberId)),
      (error: unknown) => error instanceof ConflictError && error.code === 'whatsapp.number.in_use',
    );
    assert.equal(await attributeInboundNumber(pool, owner.phoneNumberId), owner.tenant);

    // Re-assigning while still connecting replaces the tenant's number rather than
    // adding a second one: one tenant, one number.
    await withTenant(pool, tenant, (tx) => assignPhoneNumber(tx, '810000002'));
    await withTenant(pool, tenant, (tx) => assignPhoneNumber(tx, '810000003'));
    assert.equal(await withTenant(pool, tenant, readPhoneNumber), '810000003');
    assert.equal(await attributeInboundNumber(pool, '810000002'), undefined);
  });

  specTest(
    'message-delivery-reliability.md',
    'AC13 no reply is produced for a tenant that has offboarded',
    'moving to disconnected releases the route by any path, so the former number is unattributable',
    async () => {
      const manual = await connectedTenant();
      await withTenant(pool, manual.tenant, (tx) => transitionConnection(tx, 'disconnected'));
      assert.equal(await attributeInboundNumber(pool, manual.phoneNumberId), undefined);

      // A write that bypasses the library entirely — the shape offboarding or any
      // future path could take — is covered by the trigger all the same.
      const raw = await connectedTenant();
      await withTenant(pool, raw.tenant, (tx) =>
        tx.query(`UPDATE whatsapp_connections SET state = 'disconnected', changed_at = now()`),
      );
      assert.equal(await attributeInboundNumber(pool, raw.phoneNumberId), undefined);

      // A transient interruption or an error keeps the route: messages sent while
      // the platform recovers must still be received and retained.
      const blip = await connectedTenant();
      await withTenant(pool, blip.tenant, (tx) => transitionConnection(tx, 'reconnecting'));
      await withTenant(pool, blip.tenant, (tx) => transitionConnection(tx, 'error', { reason: 'recovery_exhausted' }));
      assert.equal(await attributeInboundNumber(pool, blip.phoneNumberId), blip.tenant);
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC4 a redelivered message is not stored again and not replied to again',
    'recording the same upstream message twice stores it once and reports the second as a duplicate',
    async () => {
      const { tenant, phoneNumberId } = await connectedTenant();
      const first = await withTenant(pool, tenant, (tx) => recordInboundMessage(tx, phoneNumberId, message('wamid.dup')));
      const again = await withTenant(pool, tenant, (tx) => recordInboundMessage(tx, phoneNumberId, message('wamid.dup')));
      assert.equal(first.created, true);
      assert.deepEqual(again, { id: first.id, created: false });
      const stored = await withTenant(pool, tenant, (tx) => listInboundMessages(tx));
      assert.equal(stored.length, 1);

      // The same upstream id under another tenant is another tenant's message, not
      // a duplicate — suppression is per tenant, like everything else.
      const other = await connectedTenant();
      const theirs = await withTenant(pool, other.tenant, (tx) =>
        recordInboundMessage(tx, other.phoneNumberId, message('wamid.dup')),
      );
      assert.equal(theirs.created, true);
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC5 out-of-order notifications are processed and stored in sent order',
    'messages are listed in the order the end-customer sent them, not the order they arrived',
    async () => {
      const { tenant, phoneNumberId } = await connectedTenant();
      const at = (seconds: number) => new Date(1_760_000_000_000 + seconds * 1000);
      await withTenant(pool, tenant, async (tx) => {
        // Arrival order: third, first, second — and a different customer between.
        await recordInboundMessage(tx, phoneNumberId, message('wamid.3', { sentAt: at(3) }));
        await recordInboundMessage(tx, phoneNumberId, message('wamid.other', { sentAt: at(2), customerId: '15550009999' }));
        await recordInboundMessage(tx, phoneNumberId, message('wamid.1', { sentAt: at(1) }));
        await recordInboundMessage(tx, phoneNumberId, message('wamid.2', { sentAt: at(2) }));
      });
      const listed = await withTenant(pool, tenant, (tx) => listInboundMessages(tx, { customerId: '15557654321' }));
      assert.deepEqual(
        listed.map((row) => row.externalId),
        ['wamid.1', 'wamid.2', 'wamid.3'],
      );
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC2 no data from one tenant conversation appears in another tenant context',
    "a stored message is invisible to another tenant, to the inbound scope, and to the operator's platform scope",
    async () => {
      const { tenant, phoneNumberId } = await connectedTenant();
      const other = await connectedTenant();
      const { id } = await withTenant(pool, tenant, (tx) =>
        recordInboundMessage(tx, phoneNumberId, message('wamid.private')),
      );
      assert.ok((await withTenant(pool, tenant, (tx) => readInboundMessage(tx, id))) !== undefined);
      assert.equal(await withTenant(pool, other.tenant, (tx) => readInboundMessage(tx, id)), undefined);
      assert.deepEqual(await withTenant(pool, other.tenant, (tx) => listInboundMessages(tx)), []);
      const viaInbound = await withInboundScope(pool, (tx) => tx.query('SELECT id FROM inbound_messages'));
      assert.equal(viaInbound.rows.length, 0);
      const viaPlatform = await withPlatformScope(pool, (tx) => tx.query('SELECT id FROM inbound_messages'));
      assert.equal(viaPlatform.rows.length, 0);
    },
  );

  unitTest('the stored message types agree with the database CHECK', async () => {
    const { tenant, phoneNumberId } = await connectedTenant();
    await withTenant(pool, tenant, async (tx) => {
      for (const type of INBOUND_MESSAGE_TYPES) {
        const stored = await recordInboundMessage(tx, phoneNumberId, message(`wamid.type-${type}`, { type }));
        assert.equal(stored.created, true);
      }
    });
    await assert.rejects(
      withTenant(pool, tenant, (tx) =>
        recordInboundMessage(tx, phoneNumberId, message('wamid.type-video', { type: 'video' as never })),
      ),
      ValidationError,
    );
  });

  specTest(
    'message-delivery-reliability.md',
    'AC17 delivery diagnostics contain operational information only',
    'a rejection record holds a reason, a number id, a count, and a time — readable by the operator only',
    async () => {
      await recordInboundRejection(pool, { reason: 'unattributable', phoneNumberId: '123123123', messageCount: 2 });
      // A number id from an untrusted source that is not even digits is dropped.
      await recordInboundRejection(pool, { reason: 'signature_invalid', phoneNumberId: "1'; --", messageCount: 0 });

      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'inbound_rejections' ORDER BY column_name`,
      );
      assert.deepEqual(
        columns.rows.map((row) => row.column_name),
        ['id', 'message_count', 'phone_number_id', 'reason', 'received_at'],
      );

      const seen = await withPlatformScope(pool, (tx) =>
        tx.query<{ reason: string; phone_number_id: string | null; message_count: number }>(
          'SELECT reason, phone_number_id, message_count FROM inbound_rejections ORDER BY id',
        ),
      );
      assert.ok(seen.rows.length >= 2, 'the records must exist, or the read proves nothing');
      assert.deepEqual(seen.rows.slice(-2), [
        { reason: 'unattributable', phone_number_id: '123123123', message_count: 2 },
        { reason: 'signature_invalid', phone_number_id: null, message_count: 0 },
      ]);

      // The gateway appends and never reads back; a tenant never sees the log.
      const viaInbound = await withInboundScope(pool, (tx) => tx.query('SELECT id FROM inbound_rejections'));
      assert.equal(viaInbound.rows.length, 0);
      const tenant = await newTenant();
      const viaTenant = await withTenant(pool, tenant, (tx) => tx.query('SELECT id FROM inbound_rejections'));
      assert.equal(viaTenant.rows.length, 0);
    },
  );
});
