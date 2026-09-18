/**
 * Readiness and the go-live toggle — `bot-activation-control.md`.
 *
 * ## Where the rules actually are
 *
 * Mostly in migration 0007, and deliberately so. Readiness is defined once, by
 * `app.bot_readiness_unmet`; "an active bot is ready" is a CHECK constraint;
 * re-evaluation after a readiness input changes is a trigger on each input; and
 * every on/off change is appended to `bot_activation_events` by a trigger. The
 * spec's hardest requirement — switch an active bot off when readiness is lost,
 * on whatever path loses it — cannot then depend on each such path remembering
 * to call something here.
 *
 * What this module adds is the client-facing half: reading the status, the one
 * operation that may turn a bot on, the gate the reply path asks before
 * answering, and the operator's read-only view.
 *
 * ## The reply-path gate
 *
 * `mayAutoRespond` is the only question the conversation worker (P2) may ask
 * before replying, and it must ask it inside the transaction that sends — or
 * records the send of — the reply, not once per burst ahead of time. That is what
 * makes "turn off ... with immediate effect" (AC6) true for a reply that was
 * already being generated when the client paused. There is deliberately no
 * clock, schedule, or hours argument: active means 24/7 (AC5).
 */

import type { Connection } from '@zeddev/db';
import { ConflictError, DefectError, ValidationError } from '@zeddev/errors';
import { requireTenant } from './shared.ts';

/**
 * The readiness conditions, in the order they are reported. Mirrored by
 * `app.bot_readiness_unmet` and a CHECK constraint in migration 0007; a test
 * asserts the three agree.
 */
export const READINESS_CONDITIONS = ['whatsapp_connection', 'persona'] as const;
export type ReadinessCondition = (typeof READINESS_CONDITIONS)[number];

/** What the client is told for each unmet condition (AC10). */
export const READINESS_CONDITION_DESCRIPTIONS: Readonly<Record<ReadinessCondition, string>> = {
  whatsapp_connection: 'Connect your WhatsApp number and let the platform verify it can send and receive messages.',
  persona: "Set up your bot's persona — at minimum, the name it presents itself with.",
};

export const ACTIVATION_CAUSES = ['client', 'readiness_lost'] as const;
export type ActivationCause = (typeof ACTIVATION_CAUSES)[number];

export interface BotStatus {
  readonly ready: boolean;
  readonly active: boolean;
  /** Empty exactly when `ready`. */
  readonly unmetConditions: readonly ReadinessCondition[];
  readonly firstReadyAt: Date | null;
  readonly activeChangedAt: Date | null;
  /** Why `active` last changed: the client's toggle, or lost readiness. */
  readonly activeChangeCause: ActivationCause | null;
}

export interface ActivationEvent {
  readonly active: boolean;
  readonly cause: ActivationCause;
  readonly occurredAt: Date;
}

interface StatusRow {
  ready: boolean;
  active: boolean;
  unmet_conditions: ReadinessCondition[];
  first_ready_at: Date | null;
  active_changed_at: Date | null;
  change_cause: ActivationCause | null;
}

const COLUMNS = 'ready, active, unmet_conditions, first_ready_at, active_changed_at, change_cause';

/**
 * A tenant with no `bot_activation` row has had no readiness input change since
 * the table was created, so it has neither a persona nor a connection.
 */
const NEVER_EVALUATED: BotStatus = {
  ready: false,
  active: false,
  unmetConditions: READINESS_CONDITIONS,
  firstReadyAt: null,
  activeChangedAt: null,
  activeChangeCause: null,
};

function fromRow(row: StatusRow): BotStatus {
  return {
    ready: row.ready,
    active: row.active,
    unmetConditions: row.unmet_conditions,
    firstReadyAt: row.first_ready_at,
    activeChangedAt: row.active_changed_at,
    activeChangeCause: row.change_cause,
  };
}


/** The tenant's readiness and activation state (AC3, AC10, AC11). */
export async function readBotStatus(connection: Connection): Promise<BotStatus> {
  requireTenant(connection, 'readBotStatus');
  const result = await connection.query<StatusRow>(
    `SELECT ${COLUMNS} FROM bot_activation WHERE tenant_id = app.current_tenant_id()`,
  );
  const row = result.rows[0];
  return row === undefined ? NEVER_EVALUATED : fromRow(row);
}

/** Validate a toggle request body: exactly `{ "active": true | false }`. */
export function parseActivationInput(body: Readonly<Record<string, unknown>>): boolean {
  const issues = Object.keys(body)
    .filter((key) => key !== 'active')
    .map((key) => ({ key, reason: 'is not a recognised field' }));
  if (typeof body.active !== 'boolean') issues.push({ key: 'active', reason: 'must be true or false' });
  if (issues.length > 0) throw new ValidationError(issues);
  return body.active as boolean;
}

/**
 * Turn the bot on or off — the client's toggle, and the only way a bot is ever
 * turned on.
 *
 * Readiness is re-evaluated first, under the row lock, so the decision is taken
 * against the inputs as they are now rather than against a stored evaluation;
 * and because a concurrent readiness loss must take the same lock, it either
 * commits first (and this refuses) or commits after (and switches the bot back
 * off). The CHECK constraint stands behind both.
 *
 * Asking for the state the bot is already in is not an error and records
 * nothing: there was no change to record.
 */
export async function setBotActive(connection: Connection, active: boolean): Promise<BotStatus> {
  requireTenant(connection, 'setBotActive');
  await connection.query('SELECT app.reevaluate_bot_readiness(app.current_tenant_id())');
  const current = await readBotStatus(connection);

  if (active && !current.ready) {
    // AC1, AC2: rejected, and the bot remains off. The unmet conditions are named
    // in the message because the client's next step depends on which they are.
    throw new ConflictError(
      `The bot cannot go live until it is ready. Still needed: ${current.unmetConditions.join(', ')}.`,
      { code: 'bot.not_ready', context: { unmetConditions: current.unmetConditions.join(',') } },
    );
  }
  if (current.active === active) return current;

  const result = await connection.query<StatusRow>(
    `UPDATE bot_activation
        SET active            = $1,
            change_cause      = 'client',
            active_changed_at = now()
      WHERE tenant_id = app.current_tenant_id()
      RETURNING ${COLUMNS}`,
    [active],
  );
  return fromRow(result.rows[0]!);
}

/**
 * Whether the bot may automatically reply to an end customer right now.
 *
 * `active` alone, because the CHECK constraint makes an active bot a ready one.
 * Must be called inside the transaction that sends or records the reply — see
 * the module comment.
 */
export async function mayAutoRespond(connection: Connection): Promise<boolean> {
  requireTenant(connection, 'mayAutoRespond');
  const result = await connection.query<{ active: boolean }>(
    `SELECT active FROM bot_activation WHERE tenant_id = app.current_tenant_id()`,
  );
  return result.rows[0]?.active ?? false;
}

/** Every on/off change, newest first (AC13). */
export async function readActivationHistory(
  connection: Connection,
  options: { readonly limit?: number } = {},
): Promise<ActivationEvent[]> {
  requireTenant(connection, 'readActivationHistory');
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const result = await connection.query<{ active: boolean; cause: ActivationCause; occurred_at: Date }>(
    `SELECT active, cause, occurred_at
       FROM bot_activation_events
      WHERE tenant_id = app.current_tenant_id()
      ORDER BY id DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({ active: row.active, cause: row.cause, occurredAt: row.occurred_at }));
}

/** The status as the client's screen shows it. */
export function describeBotStatus(status: BotStatus): {
  readonly ready: boolean;
  readonly active: boolean;
  readonly canGoLive: boolean;
  readonly unmetConditions: readonly { readonly condition: ReadinessCondition; readonly description: string }[];
  readonly firstReadyAt: string | null;
  readonly activeChangedAt: string | null;
  readonly activeChangeCause: ActivationCause | null;
} {
  return {
    ready: status.ready,
    active: status.active,
    canGoLive: status.ready && !status.active,
    unmetConditions: status.unmetConditions.map((condition) => ({
      condition,
      description: READINESS_CONDITION_DESCRIPTIONS[condition],
    })),
    firstReadyAt: status.firstReadyAt?.toISOString() ?? null,
    activeChangedAt: status.activeChangedAt?.toISOString() ?? null,
    activeChangeCause: status.activeChangeCause,
  };
}

/** One tenant's row in the operator's view. */
export interface OperatorBotStatus {
  readonly tenantId: string;
  readonly businessName: string;
  readonly ready: boolean;
  readonly active: boolean;
  readonly unmetConditions: readonly ReadinessCondition[];
  readonly firstReadyAt: string | null;
  readonly activeChangedAt: string | null;
}

/**
 * Every tenant's readiness and activation, for the operator (AC12).
 *
 * Read under the platform scope, from the stored evaluation — the operator can
 * see *that* a persona is missing without being able to read one. There is no
 * operator counterpart to `setBotActive`, and the table's platform policy is
 * SELECT-only, so there could not usefully be one.
 */
export async function listBotStatuses(connection: Connection): Promise<OperatorBotStatus[]> {
  // An unscoped read sees no tenants at all, which would render as an empty
  // platform rather than as the programming error it is.
  const scope = await connection.query<{ on: boolean }>('SELECT app.has_platform_scope() AS on');
  if (scope.rows[0]?.on !== true) {
    throw new DefectError('listBotStatuses requires the platform scope', { code: 'bot.platform_scope_required' });
  }
  const result = await connection.query<{
    tenant_id: string;
    business_name: string;
    ready: boolean | null;
    active: boolean | null;
    unmet_conditions: ReadinessCondition[] | null;
    first_ready_at: Date | null;
    active_changed_at: Date | null;
  }>(
    `SELECT t.id AS tenant_id, t.business_name,
            a.ready, a.active, a.unmet_conditions, a.first_ready_at, a.active_changed_at
       FROM tenants t
       LEFT JOIN bot_activation a ON a.tenant_id = t.id
      ORDER BY t.created_at, t.id`,
  );
  return result.rows.map((row) => ({
    tenantId: row.tenant_id,
    businessName: row.business_name,
    ready: row.ready ?? false,
    active: row.active ?? false,
    unmetConditions: row.unmet_conditions ?? READINESS_CONDITIONS,
    firstReadyAt: row.first_ready_at?.toISOString() ?? null,
    activeChangedAt: row.active_changed_at?.toISOString() ?? null,
  }));
}
