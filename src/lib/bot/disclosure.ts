/**
 * The client's disclosure choice — `bot-disclosure-setting.md`.
 *
 * Whether the bot tells end-customers it is an automated/AI system. Every rule
 * about it lives here: the two modes, the platform default for a tenant that
 * never chose, and the instruction text the reply path assembles from the mode.
 *
 * ## Default without a row
 *
 * A tenant that has never chosen has no row and gets
 * `PLATFORM_DEFAULT_DISCLOSURE_MODE` — so a new bot has a defined mode the moment
 * it exists, with nothing seeded (AC8). The screen reports whether the mode shown
 * was chosen or defaulted, so "is currently disclose" is always accurate (AC9).
 * Migration 0010 records why no row is seeded, and what changing the default
 * would then require.
 *
 * ## What "a new conversation" is
 *
 * The spec leaves the boundary open. This module does not decide it:
 * `disclosureDirectives` takes `conversationStart` from the caller, and P2's reply
 * path supplies it. IMPLEMENTATION_PLAN.md §3 recommends the memory-reset boundary
 * from `conversation-memory.md`, so there is one notion of "new conversation"
 * rather than two that drift.
 *
 * ## Scope and freshness
 *
 * As everywhere in `@zeddev/bot`: no function takes a tenant id, the SQL writes
 * `app.current_tenant_id()`, and row-level security hides every other tenant's
 * row (AC7). Nothing caches the mode, so a change committed before a reply's
 * transaction starts is the mode that reply follows (AC5). Nothing here touches a
 * sent message, so a change cannot rewrite history (AC6).
 */

import type { Connection } from '@zeddev/db';
import { ValidationError, type ConfigIssue } from '@zeddev/errors';
import { requireTenant } from './shared.ts';

/**
 * The two modes, and only two (the spec's "exactly two"). Mirrored by the CHECK
 * on `bot_disclosure_settings.mode` (migration 0010); a test asserts they agree.
 */
export const DISCLOSURE_MODES = ['disclose', 'do_not_disclose'] as const;
export type DisclosureMode = (typeof DISCLOSURE_MODES)[number];

/**
 * The mode of a bot whose client never chose one.
 *
 * "disclose", per the spec's stated assumption: when the client has made no
 * choice, telling an end-customer they are talking to software is the safe side
 * to err on. Changing this changes every never-chosen tenant's mode at once — see
 * migration 0010 before doing so.
 */
export const PLATFORM_DEFAULT_DISCLOSURE_MODE: DisclosureMode = 'disclose';

/** The request fields `saveDisclosureSetting` accepts. Anything else is refused by name. */
export const DISCLOSURE_FIELDS = ['mode'] as const;

/** Whether the mode in force was chosen by the client or is the platform default. */
export type DisclosureSource = 'client' | 'platform_default';

/** The tenant's disclosure mode as the platform applies it. */
export interface DisclosureSetting {
  readonly mode: DisclosureMode;
  readonly source: DisclosureSource;
  /** When the client last chose, or `null` if they never have. */
  readonly updatedAt: Date | null;
}

const NEVER_CHOSEN: DisclosureSetting = {
  mode: PLATFORM_DEFAULT_DISCLOSURE_MODE,
  source: 'platform_default',
  updatedAt: null,
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a disclosure submission, reporting every problem at once.
 *
 * The mode is required: a save with no mode has nothing to save, and reading an
 * omitted mode as "back to the default" would make a form that forgot the field
 * silently flip the bot's behaviour.
 */
export function parseDisclosureInput(body: Readonly<Record<string, unknown>>): DisclosureMode {
  const issues: ConfigIssue[] = [];
  const known = new Set<string>(DISCLOSURE_FIELDS);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) issues.push({ key, reason: 'is not a recognised field' });
  }
  const mode = body.mode;
  if (typeof mode !== 'string' || !(DISCLOSURE_MODES as readonly string[]).includes(mode)) {
    issues.push({ key: 'mode', reason: `must be one of: ${DISCLOSURE_MODES.join(', ')}` });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return mode as DisclosureMode;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface DisclosureRow {
  mode: DisclosureMode;
  updated_at: Date;
}

function fromRow(row: DisclosureRow | undefined): DisclosureSetting {
  if (row === undefined) return NEVER_CHOSEN;
  return { mode: row.mode, source: 'client', updatedAt: row.updated_at };
}

/**
 * The tenant's disclosure setting: the client's choice, or the platform default
 * if they never made one. Also what other configuration areas read to stay
 * consistent with the choice (the spec's "retrievable by the platform").
 */
export async function readDisclosureSetting(connection: Connection): Promise<DisclosureSetting> {
  requireTenant(connection, 'readDisclosureSetting');
  const result = await connection.query<DisclosureRow>(
    `SELECT mode, updated_at FROM bot_disclosure_settings WHERE tenant_id = app.current_tenant_id()`,
  );
  return fromRow(result.rows[0]);
}

/**
 * Validate and save the client's choice (AC5). Choosing the mode that happens to
 * be the default still records a choice: the bot then keeps that mode even if
 * the platform default later changes.
 *
 * Takes the raw submission rather than a `DisclosureMode` so that validation is
 * not a step a caller can skip.
 */
export async function saveDisclosureSetting(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<DisclosureSetting> {
  requireTenant(connection, 'saveDisclosureSetting');
  const mode = parseDisclosureInput(body);
  const result = await connection.query<DisclosureRow>(
    `INSERT INTO bot_disclosure_settings (tenant_id, mode)
     VALUES (app.current_tenant_id(), $1)
     ON CONFLICT (tenant_id) DO UPDATE
       SET mode = EXCLUDED.mode, updated_at = now()
     RETURNING mode, updated_at`,
    [mode],
  );
  return fromRow(result.rows[0]);
}

// ---------------------------------------------------------------------------
// What the rest of the platform consumes
// ---------------------------------------------------------------------------

/** The mode the reply path follows, read inside the caller's tenant-bound transaction. */
export async function disclosureModeFor(connection: Connection): Promise<DisclosureMode> {
  return (await readDisclosureSetting(connection)).mode;
}

/**
 * The disclosure section of the reply prompt. The only renderer of it: P2's
 * prompt assembly must call this rather than phrase disclosure itself.
 *
 * - `disclose`: at the start of a new conversation the reply opens with a clear
 *   statement that the customer is talking to an automated AI assistant (AC1),
 *   and at any point a question about the bot's nature is answered truthfully
 *   (AC2). The exact wording is the bot's own, in its persona's voice — the spec
 *   leaves phrasing to persona and tone.
 * - `do_not_disclose`: the bot must not volunteer it, at the start or later (AC3,
 *   AC4). Deliberately says nothing about what to answer if asked: the spec does
 *   not require denial, and whether evasion or denial is permitted belongs to the
 *   client's behaviour rules, which are rendered alongside this.
 */
export function disclosureDirectives(mode: DisclosureMode, options: { readonly conversationStart: boolean }): string {
  if (mode === 'do_not_disclose') {
    return (
      'Do not state or suggest, on your own initiative, that you are an automated system or an AI — ' +
      'not when the conversation starts and not later.'
    );
  }
  const lines: string[] = [];
  if (options.conversationStart) {
    lines.push(
      'This is the start of a new conversation. Your reply must open with a clear statement that the ' +
        'customer is talking to an automated AI assistant, not a human.',
    );
  }
  lines.push(
    'If the customer asks, in any words and at any point in the conversation, whether they are talking to ' +
      'a human or a bot, answer clearly that you are an automated AI assistant, not a human.',
  );
  return lines.join('\n');
}

/**
 * The setting as the client's screen shows it: the mode in force, whether it was
 * chosen or defaulted, and the modes and default the form needs, so it has no
 * reason to hard-code them (AC9).
 */
export function describeDisclosureSetting(setting: DisclosureSetting): {
  readonly mode: DisclosureMode;
  readonly source: DisclosureSource;
  readonly updatedAt: string | null;
  readonly modes: typeof DISCLOSURE_MODES;
  readonly platformDefault: DisclosureMode;
} {
  return {
    mode: setting.mode,
    source: setting.source,
    updatedAt: setting.updatedAt?.toISOString() ?? null,
    modes: DISCLOSURE_MODES,
    platformDefault: PLATFORM_DEFAULT_DISCLOSURE_MODE,
  };
}
