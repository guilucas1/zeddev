/**
 * Connecting, verifying, replacing, and disconnecting a tenant's number —
 * `whatsapp-number-connection.md`'s self-service flow.
 *
 * ## What "verified" means here, and why it is not weaker
 *
 * The spec's last behavioural requirement is the one that shapes this module:
 * a tenant "must not [be] marked 'connected' based solely on the client
 * submitting credentials/configuration — connection status must reflect a
 * verified, working link". Three progressively weaker proofs were available:
 *
 *   1. The credentials parse. Proves nothing; this is exactly what the spec
 *      forbids.
 *   2. Meta accepts the token and reports the account subscribed to the
 *      platform's app. Proves the token is live and that Meta *intends* to
 *      deliver notifications — but not that any notification reaches *this*
 *      deployment's webhook URL, which is the single most common thing to get
 *      wrong and the one a client cannot diagnose.
 *   3. A real message goes out through the Cloud API and the reply comes back in
 *      through the platform's own webhook.
 *
 * Only (3) proves send *and* receive, so that is what `connecting → connected`
 * costs. It also makes the flow genuinely guided: the client nominates a number
 * they control, gets a code on WhatsApp, and replies to it.
 *
 * ## Why the model of "one number per tenant" is structural, not checked
 *
 * `whatsapp_connections` is keyed by tenant and `whatsapp_number_routes` is
 * UNIQUE on tenant. A second concurrent number is not a state the database can
 * hold, which is what AC12 ("never an ambiguous state where two numbers are
 * simultaneously treated as the tenant's active number") asks for. AC3's refusal
 * is therefore a courtesy — a clear error instead of a constraint violation — and
 * not the guarantee itself.
 *
 * ## Why replacement cuts over immediately
 *
 * AC8 requires the old number stop "no later than the new number reaches
 * connected", and AC12 forbids any dual-active instant. With one row per tenant,
 * the only representable cutover is immediate: one transaction disconnects the
 * old number (which drops its route, so it stops being attributable) and begins
 * connecting the new one. The client's bot is off the air between the two, which
 * `bot-activation-control.md` already describes — readiness is unmet while a
 * connection is `connecting`. The alternative, holding both numbers live until
 * the new one verifies, is exactly the ambiguous window AC12 rules out.
 */

import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { Connection } from '@zeddev/db';
import { ConflictError, DefectError, NotFoundError, ValidationError, type ConfigIssue } from '@zeddev/errors';
import type { SecretSealer } from '@zeddev/secrets';
import { deleteTenantSecret, putTenantSecret, requireTenantSecret } from '@zeddev/vault';
import { META_ID, WHATSAPP_ADDRESS, type CloudCredentials } from './cloud.ts';
import {
  readConnection,
  transitionConnection,
  type ConnectionErrorReason,
  type ConnectionState,
  type ConnectionStatus,
} from './connection.ts';
// `ConnectionState` is used by STATES_HOLDING_A_NUMBER below.
import { assignPhoneNumber, readPhoneNumber } from './inbound.ts';

/** Mirrored by a CHECK constraint in migration 0015. */
export const VERIFICATION_FAILURES = ['send_failed', 'reply_not_received', 'superseded'] as const;
export type VerificationFailure = (typeof VERIFICATION_FAILURES)[number];

export const VERIFICATION_OUTCOMES = ['pending', 'passed', 'failed'] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

/**
 * What the client is told to do, and the order it happens in (AC4).
 *
 * Kept as data rather than as prose in a dashboard template so that the API, the
 * dashboard, and the tests all describe the same flow.
 *
 * `currentStep` derives which one is outstanding from the connection state, so
 * this table carries no state of its own — a step that named its own state would
 * be a second answer to "where is this connection".
 */
export const CONNECTION_STEPS = [
  {
    key: 'authorize',
    title: 'Authorize the platform on Meta',
    detail:
      'In WhatsApp Manager, add this platform as a partner on the WhatsApp Business Account that owns your number, ' +
      'and generate a system user access token with permission to manage it. The platform never sees your Meta ' +
      'password and cannot do this step for you.',
  },
  {
    key: 'submit',
    title: 'Enter your number and token',
    detail:
      'Give the platform the phone number id, the WhatsApp Business Account id, and the access token. Submitting ' +
      'them does not connect the number: the connection stays "connecting" until the next two steps succeed.',
  },
  {
    key: 'send',
    title: 'Receive a code on WhatsApp',
    detail:
      'The platform subscribes to your account’s notifications and sends a short code from your business ' +
      'number to a WhatsApp number you control. If this fails, the reason says what Meta refused and why.',
  },
  {
    key: 'reply',
    title: 'Reply with the code',
    detail:
      'Reply to that message with the code. Your reply travels back through WhatsApp to the platform, which is what ' +
      'proves the number can receive as well as send. The connection becomes "connected" when it arrives.',
  },
] as const satisfies readonly { key: string; title: string; detail: string }[];

export type ConnectionStepKey = (typeof CONNECTION_STEPS)[number]['key'];

export const CONNECTION_LIMITS = {
  /** Digits in the one-time code. Six is the length a person retypes without error. */
  codeDigits: 6,
  /** How long a client has to reply before the attempt is abandoned. */
  verificationTtlMs: 15 * 60_000,
} as const;

export interface CredentialSubmission {
  readonly phoneNumberId: string;
  readonly businessAccountId: string;
  readonly accessToken: string;
}

export interface PendingVerification {
  readonly id: string;
  readonly recipient: string;
  readonly expiresAt: Date;
}

export interface VerificationSummary {
  readonly id: string;
  readonly recipient: string;
  readonly outcome: VerificationOutcome;
  readonly failure: VerificationFailure | null;
  readonly startedAt: Date;
  readonly expiresAt: Date;
  readonly completedAt: Date | null;
}

/** What `consumeVerificationReply` decided about one inbound message. */
export type VerificationReplyOutcome =
  /** Not a verification reply: record and route it as an ordinary message. */
  | 'not_awaited'
  /** The redelivery of a reply that already passed. Record nothing; it was consumed. */
  | 'already_consumed'
  /** From the right number, but not the code. Record it; the client may just be talking. */
  | 'mismatch'
  /** The right code, too late. */
  | 'expired'
  /** The link is proven. The connection is now `connected`. */
  | 'verified';

const VERIFICATION_COLUMNS =
  'id, recipient, outcome, failure, started_at, expires_at, completed_at';

interface VerificationRow {
  id: string;
  recipient: string;
  outcome: VerificationOutcome;
  failure: VerificationFailure | null;
  started_at: Date;
  expires_at: Date;
  completed_at: Date | null;
}

function toSummary(row: VerificationRow): VerificationSummary {
  return {
    id: row.id,
    recipient: row.recipient,
    outcome: row.outcome,
    failure: row.failure,
    startedAt: row.started_at,
    expiresAt: row.expires_at,
    completedAt: row.completed_at,
  };
}

function requireTenant(connection: Connection, operation: string): string {
  if (connection.boundTenantId === undefined) {
    throw new DefectError(`${operation} requires a tenant-bound connection`, { code: 'whatsapp.tenant_unbound' });
  }
  return connection.boundTenantId;
}

/** The digest stored in place of the code. See migration 0015 for why it is not the code. */
export function digestVerificationCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * A fresh one-time code.
 *
 * `randomInt` rather than `Math.random`: the code is the only thing standing
 * between an attacker who can reach the client's WhatsApp and a number verified
 * on their behalf, and a predictable sequence would remove it.
 */
export function generateVerificationCode(): string {
  const max = 10 ** CONNECTION_LIMITS.codeDigits;
  return String(randomInt(0, max)).padStart(CONNECTION_LIMITS.codeDigits, '0');
}

/** Constant-time comparison of two hex digests, so a reply cannot be tuned by timing. */
function digestsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Parse and check a submission, reporting every problem at once.
 *
 * Every field is checked here and nowhere else, so the API route, a future CLI,
 * and a test all refuse the same inputs. Validation before any Meta call matters
 * for more than tidiness: a malformed id would otherwise become a Graph 400 that
 * classifies as `configuration_invalid`, which reads to the client as "Meta
 * rejected your number" rather than "this field is wrong".
 */
export function parseCredentialSubmission(input: unknown): CredentialSubmission {
  const value = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const issues: ConfigIssue[] = [];

  const text = (key: string): string => (typeof value[key] === 'string' ? (value[key] as string).trim() : '');
  const phoneNumberId = text('phoneNumberId');
  const businessAccountId = text('businessAccountId');
  const accessToken = text('accessToken');
  const verificationRecipient = text('verificationRecipient').replace(/^\+/, '');

  if (!META_ID.test(phoneNumberId)) {
    issues.push({ key: 'phoneNumberId', reason: 'must be the numeric phone number id from WhatsApp Manager' });
  }
  if (!META_ID.test(businessAccountId)) {
    issues.push({ key: 'businessAccountId', reason: 'must be the numeric WhatsApp Business Account id' });
  }
  if (accessToken.length < 16) {
    issues.push({ key: 'accessToken', reason: 'must be the access token generated for this account' });
  }
  if (issues.length > 0) throw new ValidationError(issues);

  return { phoneNumberId, businessAccountId, accessToken };
}

/**
 * Where the platform should prove it can send.
 *
 * A separate request from the submission, and deliberately repeatable: a client
 * whose first code went to a phone they left at home should be able to ask for
 * another to a different number without re-entering a token they already got
 * right. Not the business number itself — the Cloud API will not deliver a
 * message from a number to itself, and verifying against it would prove nothing
 * about whether anyone else can reach it.
 */
export function parseVerificationRequest(input: unknown): { readonly recipient: string } {
  const value = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const recipient = (typeof value['recipient'] === 'string' ? value['recipient'] : '').trim().replace(/^\+/, '');
  if (!WHATSAPP_ADDRESS.test(recipient)) {
    throw new ValidationError([
      { key: 'recipient', reason: 'must be a WhatsApp number you can read, in international format' },
    ]);
  }
  return { recipient };
}

/** The states in which the tenant already has a number and may not add another (AC3). */
const STATES_HOLDING_A_NUMBER: readonly ConnectionState[] = ['connected', 'reconnecting'];

export interface SubmitOptions {
  /** Who is submitting, for the secret access record. A principal id, never a credential. */
  readonly principal: string;
  /**
   * Replace the number the tenant already has.
   *
   * A distinct flag rather than a distinct function because the two flows differ
   * by exactly one step — tearing the old number down — and splitting them would
   * mean two places that seal a token and assign a route.
   */
  readonly replace?: boolean | undefined;
}

/**
 * Step 2: store what the client submitted and enter `connecting`.
 *
 * Deliberately performs no Meta call. AC2 requires that submitting credentials
 * leaves the tenant in `connecting`, and making this step purely local is what
 * makes that true by construction rather than by remembering not to set
 * `connected` somewhere later.
 *
 * Re-submitting while already `connecting` is allowed and replaces everything: a
 * client who mistyped a token should correct it, not disconnect first. Any
 * verification in flight is superseded, because it was sent with credentials that
 * no longer apply.
 */
export async function submitCredentials(
  connection: Connection,
  sealer: SecretSealer,
  submission: CredentialSubmission,
  options: SubmitOptions,
): Promise<ConnectionStatus> {
  requireTenant(connection, 'submitCredentials');
  const current = await readConnection(connection);

  if (STATES_HOLDING_A_NUMBER.includes(current.state) && options.replace !== true) {
    throw new ConflictError(
      'This tenant already has a WhatsApp number. Disconnect it, or replace it, before connecting another.',
      { code: 'whatsapp.connection.already_connected', context: { state: current.state } },
    );
  }

  // The replacement cutover. Going through `disconnected` rather than adding a
  // `connected → connecting` edge is what guarantees the old number stops first:
  // the route-release trigger fires on this transition, so by the time the new
  // route is assigned the old number is already unattributable.
  if (STATES_HOLDING_A_NUMBER.includes(current.state)) {
    await transitionConnection(connection, 'disconnected');
  }

  const state = await readConnection(connection);
  if (state.state !== 'connecting') {
    await transitionConnection(connection, 'connecting');
  }

  await supersedePendingVerification(connection);
  await assignPhoneNumber(connection, submission.phoneNumberId);
  await connection.query(
    `UPDATE whatsapp_connections
        SET business_account_id = $1, display_number = NULL, verified_name = NULL
      WHERE tenant_id = app.current_tenant_id()`,
    [submission.businessAccountId],
  );
  await putTenantSecret(connection, sealer, {
    secretClass: 'tenant_whatsapp_credential',
    value: submission.accessToken,
    principal: options.principal,
  });
  return readConnection(connection);
}

/**
 * The credentials to reach this tenant's number with.
 *
 * The single way a stored token is turned back into something callable, so every
 * such use is one access record in `secret_access_records` (AC14). Refuses a
 * tenant with no number rather than returning partial credentials, because a
 * Graph call with an empty id is a 400 that classifies as a configuration
 * problem the client cannot act on.
 */
export async function loadCloudCredentials(
  connection: Connection,
  sealer: SecretSealer,
  options: { readonly principal: string },
): Promise<CloudCredentials> {
  requireTenant(connection, 'loadCloudCredentials');
  const phoneNumberId = await readPhoneNumber(connection);
  const result = await connection.query<{ business_account_id: string | null }>(
    `SELECT business_account_id FROM whatsapp_connections WHERE tenant_id = app.current_tenant_id()`,
  );
  const businessAccountId = result.rows[0]?.business_account_id ?? null;
  if (phoneNumberId === undefined || businessAccountId === null) {
    throw new NotFoundError('a WhatsApp number for this tenant');
  }
  const accessToken = await requireTenantSecret(connection, sealer, 'tenant_whatsapp_credential', options);
  return { accessToken, phoneNumberId, businessAccountId };
}

async function supersedePendingVerification(connection: Connection): Promise<void> {
  await connection.query(
    `UPDATE whatsapp_connection_verifications
        SET outcome = 'failed', failure = 'superseded', completed_at = now()
      WHERE tenant_id = app.current_tenant_id() AND outcome = 'pending'`,
  );
}

/**
 * Step 3a: open a verification attempt, before the code goes out.
 *
 * Recorded *before* the send so that a send which succeeds and then crashes the
 * process leaves an attempt the client can see and retry, rather than a code on
 * their phone that the platform has no memory of. The reverse order optimises for
 * the case that never causes support tickets.
 *
 */
export async function beginVerification(
  connection: Connection,
  input: { readonly recipient: string; readonly code: string; readonly expiresAt: Date },
): Promise<PendingVerification> {
  requireTenant(connection, 'beginVerification');
  const status = await readConnection(connection);
  if (status.state !== 'connecting') {
    throw new ConflictError('A verification can only be started while the connection is connecting.', {
      code: 'whatsapp.verification.not_connecting',
      context: { state: status.state },
    });
  }
  const phoneNumberId = await readPhoneNumber(connection);
  if (phoneNumberId === undefined) {
    throw new NotFoundError('a WhatsApp number for this tenant');
  }

  await supersedePendingVerification(connection);
  const result = await connection.query<{ id: string }>(
    `INSERT INTO whatsapp_connection_verifications
       (tenant_id, phone_number_id, recipient, code_digest, expires_at)
     VALUES (app.current_tenant_id(), $1, $2, $3, $4)
     RETURNING id`,
    [phoneNumberId, input.recipient, digestVerificationCode(input.code), input.expiresAt],
  );
  return { id: result.rows[0]!.id, recipient: input.recipient, expiresAt: input.expiresAt };
}

/**
 * Step 3b: the code reached Meta.
 *
 * Also the first point at which Meta has told us how the number renders, so the
 * display details are written here. Recording them before the reply arrives is
 * deliberate: a client stuck at the reply step needs to see *which* number the
 * code went out from in order to notice they connected the wrong one.
 */
export async function recordVerificationSent(
  connection: Connection,
  verificationId: string,
  sent: {
    readonly outboundMessageId: string;
    readonly displayNumber?: string | undefined;
    readonly verifiedName?: string | undefined;
  },
): Promise<void> {
  requireTenant(connection, 'recordVerificationSent');
  await connection.query(
    `UPDATE whatsapp_connection_verifications
        SET outbound_message_id = $2
      WHERE tenant_id = app.current_tenant_id() AND id = $1 AND outcome = 'pending'`,
    [verificationId, sent.outboundMessageId],
  );
  await connection.query(
    `UPDATE whatsapp_connections
        SET display_number = $1, verified_name = $2
      WHERE tenant_id = app.current_tenant_id()`,
    [sent.displayNumber ?? null, sent.verifiedName ?? null],
  );
}

/**
 * Abandon an attempt, optionally moving the connection to `error`.
 *
 * The error reason is passed in rather than derived here because only the caller
 * saw what Meta said, and `classifyCloudFailure` has already turned it into this
 * vocabulary. Passing `undefined` abandons the attempt while leaving the
 * connection in `connecting` — right for a failure the client can simply retry.
 */
export async function abandonVerification(
  connection: Connection,
  verificationId: string,
  failure: VerificationFailure,
  options: { readonly errorReason?: ConnectionErrorReason | undefined } = {},
): Promise<ConnectionStatus> {
  requireTenant(connection, 'abandonVerification');
  await connection.query(
    `UPDATE whatsapp_connection_verifications
        SET outcome = 'failed', failure = $2, completed_at = now()
      WHERE tenant_id = app.current_tenant_id() AND id = $1 AND outcome = 'pending'`,
    [verificationId, failure],
  );
  if (options.errorReason === undefined) return readConnection(connection);
  return transitionConnection(connection, 'error', { reason: options.errorReason });
}

/**
 * Abandon an attempt whose reply never came (AC6, at the connect stage).
 *
 * Evaluated lazily, when the connection is read, rather than by a timer. There is
 * no scheduler yet, and a timer would be the only thing in the platform that has
 * to be running for a *state* to be correct. Reading is the only moment the
 * answer matters, which is the classic argument for lazy expiry — and it means a
 * deployment that was down over the window still reports the right thing.
 */
export async function expireStaleVerification(connection: Connection): Promise<ConnectionStatus> {
  requireTenant(connection, 'expireStaleVerification');
  const expired = await connection.query<{ id: string }>(
    `UPDATE whatsapp_connection_verifications
        SET outcome = 'failed', failure = 'reply_not_received', completed_at = now()
      WHERE tenant_id = app.current_tenant_id() AND outcome = 'pending' AND expires_at <= now()
      RETURNING id`,
  );
  const status = await readConnection(connection);
  if (expired.rowCount === 0 || status.state !== 'connecting') return status;
  return transitionConnection(connection, 'error', { reason: 'verification_failed' });
}

/**
 * The receive leg: decide what an inbound message means for a pending
 * verification.
 *
 * Called by the gateway for every inbound text before the message is stored,
 * under the tenant it has already attributed the notification to. A message this
 * function claims is never stored and never reaches the conversation worker — the
 * code is platform plumbing, and answering it as if an end-customer had said it
 * would be both confusing and, since the "customer" is the client themselves, a
 * conversation the client never wanted.
 *
 * Only a reply *from the nominated number* can pass. Matching on text alone would
 * let any end-customer who happened to send six digits complete a stranger's
 * connection.
 */
export async function consumeVerificationReply(
  connection: Connection,
  message: { readonly customerId: string; readonly text: string; readonly externalId: string },
): Promise<VerificationReplyOutcome> {
  requireTenant(connection, 'consumeVerificationReply');

  const seen = await connection.query<{ id: string }>(
    `SELECT id FROM whatsapp_connection_verifications
      WHERE tenant_id = app.current_tenant_id() AND inbound_external_id = $1`,
    [message.externalId],
  );
  if (seen.rowCount > 0) return 'already_consumed';

  const pending = await connection.query<{ id: string; recipient: string; code_digest: string; expired: boolean }>(
    `SELECT id, recipient, code_digest, (expires_at <= now()) AS expired
       FROM whatsapp_connection_verifications
      WHERE tenant_id = app.current_tenant_id() AND outcome = 'pending'
      FOR UPDATE`,
  );
  const attempt = pending.rows[0];
  if (attempt === undefined || attempt.recipient !== message.customerId) return 'not_awaited';

  // A person replies "123456", "Code 123456", or quotes the whole sentence back.
  // Comparing whole digit runs accepts all three without accepting a six-digit
  // substring of a longer number, which would make a phone number a valid code.
  const candidates = message.text.match(/\d+/g) ?? [];
  const matched = candidates.some((run) => digestsMatch(digestVerificationCode(run), attempt.code_digest));
  if (!matched) return 'mismatch';
  if (attempt.expired) return 'expired';

  await connection.query(
    `UPDATE whatsapp_connection_verifications
        SET outcome = 'passed', completed_at = now(), inbound_external_id = $2
      WHERE tenant_id = app.current_tenant_id() AND id = $1`,
    [attempt.id, message.externalId],
  );
  await transitionConnection(connection, 'connected');
  return 'verified';
}

/** The tenant's most recent verification attempt, or none. */
export async function readVerification(connection: Connection): Promise<VerificationSummary | undefined> {
  requireTenant(connection, 'readVerification');
  const result = await connection.query<VerificationRow>(
    `SELECT ${VERIFICATION_COLUMNS} FROM whatsapp_connection_verifications
      WHERE tenant_id = app.current_tenant_id()
      ORDER BY started_at DESC, id DESC
      LIMIT 1`,
  );
  const row = result.rows[0];
  return row === undefined ? undefined : toSummary(row);
}

export interface ConnectedNumber {
  readonly phoneNumberId: string;
  readonly businessAccountId: string;
  readonly displayNumber: string | null;
  readonly verifiedName: string | null;
}

/** The number the tenant is connecting or connected to, as a product surface may show it. */
export async function readConnectedNumber(connection: Connection): Promise<ConnectedNumber | undefined> {
  requireTenant(connection, 'readConnectedNumber');
  const phoneNumberId = await readPhoneNumber(connection);
  const result = await connection.query<{
    business_account_id: string | null;
    display_number: string | null;
    verified_name: string | null;
  }>(
    `SELECT business_account_id, display_number, verified_name
       FROM whatsapp_connections WHERE tenant_id = app.current_tenant_id()`,
  );
  const row = result.rows[0];
  if (phoneNumberId === undefined || row?.business_account_id == null) return undefined;
  return {
    phoneNumberId,
    businessAccountId: row.business_account_id,
    displayNumber: row.display_number,
    verifiedName: row.verified_name,
  };
}

/**
 * The client's manual disconnect (AC7), with the credential destroyed.
 *
 * Deleting the token is not incidental. `credential-and-secret-handling.md` AC10
 * requires a superseded credential stop working "immediately … including from a
 * cached copy", and a disconnected number's token is superseded by definition:
 * nothing in the platform may send with it again. Keeping it would also leave a
 * tenant who disconnected in protest still holding a live credential in the
 * platform's database.
 */
export async function disconnectNumber(
  connection: Connection,
  options: { readonly principal: string },
): Promise<ConnectionStatus> {
  requireTenant(connection, 'disconnectNumber');
  const current = await readConnection(connection);
  await supersedePendingVerification(connection);
  await deleteTenantSecret(connection, 'tenant_whatsapp_credential', options);
  if (current.state === 'disconnected') return current;
  return transitionConnection(connection, 'disconnected');
}

/**
 * The step the client is on, given where the connection is.
 *
 * `connected` is past every step; anything else names the first step not yet
 * done. Derived rather than stored because a stored step is a second answer to
 * "where is this connection", and the two would drift.
 */
export function currentStep(status: ConnectionStatus, verification: VerificationSummary | undefined): ConnectionStepKey | null {
  if (status.state === 'connected') return null;
  if (status.state !== 'connecting') return 'authorize';
  return verification?.outcome === 'pending' ? 'reply' : 'send';
}

/** The connection setup as the client's screen shows it. */
export function describeConnectionSetup(
  status: ConnectionStatus,
  number: ConnectedNumber | undefined,
  verification: VerificationSummary | undefined,
): {
  readonly number: {
    readonly phoneNumberId: string;
    readonly businessAccountId: string;
    readonly displayNumber: string | null;
    readonly verifiedName: string | null;
    /** AC6 of the credential spec: that a credential is configured, never its value. */
    readonly credentialConfigured: true;
  } | null;
  readonly verification: {
    readonly recipient: string;
    readonly outcome: VerificationOutcome;
    readonly failure: VerificationFailure | null;
    readonly startedAt: string;
    readonly expiresAt: string;
    readonly completedAt: string | null;
  } | null;
  readonly currentStep: ConnectionStepKey | null;
  readonly steps: readonly { readonly key: string; readonly title: string; readonly detail: string }[];
} {
  return {
    number:
      number === undefined
        ? null
        : {
            phoneNumberId: number.phoneNumberId,
            businessAccountId: number.businessAccountId,
            displayNumber: number.displayNumber,
            verifiedName: number.verifiedName,
            credentialConfigured: true,
          },
    verification:
      verification === undefined
        ? null
        : {
            recipient: verification.recipient,
            outcome: verification.outcome,
            failure: verification.failure,
            startedAt: verification.startedAt.toISOString(),
            expiresAt: verification.expiresAt.toISOString(),
            completedAt: verification.completedAt?.toISOString() ?? null,
          },
    currentStep: currentStep(status, verification),
    steps: CONNECTION_STEPS.map((step) => ({ key: step.key, title: step.title, detail: step.detail })),
  };
}

/** The message the code goes out in. One place, so the code's format is one decision. */
export function connectionCodeMessage(code: string): string {
  return (
    `Your connection code is ${code}. ` +
    'Reply to this message with that code to finish connecting this number to your chatbot.'
  );
}
