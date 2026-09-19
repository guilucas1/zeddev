/**
 * The client's human-handoff configuration — `human-handoff.md`.
 *
 * Whether handoff is enabled for the bot, and which conditions trigger it. Every
 * rule about that lives here: the built-in triggers, the platform default for a
 * tenant that never configured handoff, what a valid client-written condition
 * is, the instruction text the reply path assembles from the configuration, and
 * the one decision of whether a handoff signal becomes a handoff or a fallback.
 *
 * ## Default without a row
 *
 * A tenant that has never saved has no row and gets the platform default:
 * handoff **disabled**, with all three built-in triggers selected. Disabled
 * because a handoff pauses a conversation until a person at the business acts on
 * it, and a client who has never seen the setting is not watching for that — a
 * canned fallback reply is a better outcome than a customer left waiting on a
 * person nobody knows is needed. The triggers are pre-selected so that enabling
 * handoff without touching them gives the spec's "default trigger conditions"
 * (AC2). The screen reports whether what it shows was saved or defaulted.
 *
 * ## Configuration, not conversation state
 *
 * Whether one conversation is paused is per-conversation state, recorded when a
 * handoff fires (P2). Nothing here reads or writes it, so no save — including
 * disabling handoff — can reactivate a conversation already handed off (AC13):
 * the setting governs new trigger evaluations only.
 *
 * ## Scope and freshness
 *
 * As everywhere in `@zeddev/bot`: no function takes a tenant id, the SQL writes
 * `app.current_tenant_id()`, and row-level security hides every other tenant's
 * row. Nothing caches the configuration, so the reply path, reading it inside
 * the transaction that assembles the reply, evaluates every message against the
 * configuration committed before it.
 */

import type { Connection } from '@zeddev/db';
import { ValidationError, type ConfigIssue } from '@zeddev/errors';
import type { FallbackTrigger } from './fallback.ts';
import { characters, CONTROL, requireTenant } from './shared.ts';

/**
 * The built-in triggers — the minimum set the spec requires be available. Each
 * is selected or not; the list is fixed, and anything else a client wants is a
 * custom condition in their own words. Mirrored by the CHECK on
 * `bot_handoff_settings.triggers` (migration 0011); a test asserts they agree.
 *
 * `out_of_scope` is the same name `fallback.ts` uses for the same situation, on
 * purpose: it is one condition, handled by handoff or by fallback depending on
 * whether handoff is enabled.
 */
export const HANDOFF_TRIGGERS = ['human_request', 'complaint', 'out_of_scope'] as const;
export type HandoffTrigger = (typeof HANDOFF_TRIGGERS)[number];

/** What each built-in trigger means — shown on the screen and rendered into the prompt. */
export const HANDOFF_TRIGGER_DESCRIPTIONS: Readonly<Record<HandoffTrigger, string>> = {
  human_request: 'The customer explicitly asks to speak to a person rather than the automated assistant.',
  complaint: 'The customer is complaining about the business, its products, or its service.',
  out_of_scope:
    "The customer's message is about something you are not set up to handle: nothing in the business's " +
    'information or your instructions covers it.',
};

/** Whether handoff is enabled for a tenant that never configured it. See the module comment. */
export const PLATFORM_DEFAULT_HANDOFF_ENABLED = false;

/** The built-in triggers selected for a tenant that never configured handoff: all of them. */
export const PLATFORM_DEFAULT_HANDOFF_TRIGGERS: readonly HandoffTrigger[] = HANDOFF_TRIGGERS;

/**
 * Limits on client-written conditions, in characters (Unicode code points — what
 * PostgreSQL counts). Mirrored by migration 0011. Same reasoning as
 * `BEHAVIOR_LIMITS`: every condition is rendered into every reply's prompt, paid
 * for in model context on a free-tier provider. A condition is a sentence, and
 * twenty is more than a small business needs to describe when a person should
 * step in.
 */
export const HANDOFF_LIMITS = {
  conditionMaxLength: 300,
  maxConditions: 20,
} as const;

/** The request fields `saveHandoffSettings` accepts. Anything else is refused by name. */
export const HANDOFF_FIELDS = ['enabled', 'triggers', 'customConditions'] as const;

/** Whether the configuration in force was saved by the client or is the platform default. */
export type HandoffSource = 'client' | 'platform_default';

/** A validated configuration, not yet saved. */
export interface HandoffPolicy {
  readonly enabled: boolean;
  /** Selected built-in triggers, de-duplicated, in `HANDOFF_TRIGGERS` order. */
  readonly triggers: readonly HandoffTrigger[];
  /** The client's own conditions, in the order written. */
  readonly customConditions: readonly string[];
}

/** The tenant's handoff configuration as the platform applies it. */
export interface HandoffSettings extends HandoffPolicy {
  readonly source: HandoffSource;
  /** When the client last saved, or `null` if they never have. */
  readonly updatedAt: Date | null;
}

const NEVER_CONFIGURED: HandoffSettings = {
  enabled: PLATFORM_DEFAULT_HANDOFF_ENABLED,
  triggers: PLATFORM_DEFAULT_HANDOFF_TRIGGERS,
  customConditions: [],
  source: 'platform_default',
  updatedAt: null,
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const NO_TRIGGER = 'cannot be true with no trigger selected and no condition written';

function enabledFlag(raw: unknown, issues: ConfigIssue[]): boolean {
  if (typeof raw === 'boolean') return raw;
  issues.push({ key: 'enabled', reason: raw === undefined || raw === null ? 'is required' : 'must be true or false' });
  return false;
}

function triggerList(raw: unknown, issues: ConfigIssue[]): HandoffTrigger[] {
  const offered = HANDOFF_TRIGGERS as readonly string[];
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string' || !offered.includes(item))) {
    issues.push({
      key: 'triggers',
      reason:
        raw === undefined || raw === null
          ? 'is required'
          : `must be a list drawn from: ${HANDOFF_TRIGGERS.join(', ')}`,
    });
    return [];
  }
  // Exact values only, so the fixed list cannot widen; order and repeats carry no meaning.
  return HANDOFF_TRIGGERS.filter((trigger) => raw.includes(trigger));
}

/**
 * The client's own conditions. Each is one line of plain language, trimmed and
 * NFC-normalised; blank entries are dropped rather than stored, and a repeat is
 * refused rather than silently merged, because the screen would otherwise show
 * one fewer condition than the client typed. Reasons never echo the value.
 */
function conditionList(raw: unknown, issues: ConfigIssue[]): string[] {
  if (raw === undefined || raw === null) {
    issues.push({ key: 'customConditions', reason: 'is required' });
    return [];
  }
  if (!Array.isArray(raw)) {
    issues.push({ key: 'customConditions', reason: 'must be a list of text' });
    return [];
  }
  const conditions: string[] = [];
  raw.forEach((item: unknown, index) => {
    const key = `customConditions[${index}]`;
    if (typeof item !== 'string') {
      issues.push({ key, reason: 'must be a string' });
      return;
    }
    const text = item.normalize('NFC').trim();
    if (text === '') return;
    if (CONTROL.test(text)) {
      issues.push({ key, reason: 'must be a single line of text' });
    } else if (characters(text) > HANDOFF_LIMITS.conditionMaxLength) {
      issues.push({ key, reason: `must be at most ${HANDOFF_LIMITS.conditionMaxLength} characters` });
    } else if (conditions.includes(text)) {
      issues.push({ key, reason: 'repeats an earlier condition' });
    } else {
      conditions.push(text);
    }
  });
  if (conditions.length > HANDOFF_LIMITS.maxConditions) {
    issues.push({ key: 'customConditions', reason: `must hold at most ${HANDOFF_LIMITS.maxConditions} conditions` });
  }
  return conditions;
}

/**
 * Validate a whole handoff configuration, reporting every problem at once.
 *
 * All three fields are required: a save replaces the whole configuration, and
 * reading an omitted field as "empty" or "default" would let a form that forgot
 * one silently switch triggers off.
 */
export function parseHandoffInput(body: Readonly<Record<string, unknown>>): HandoffPolicy {
  const issues: ConfigIssue[] = [];
  const known = new Set<string>(HANDOFF_FIELDS);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) issues.push({ key, reason: 'is not a recognised field' });
  }
  const enabled = enabledFlag(body.enabled, issues);
  const triggers = triggerList(body.triggers, issues);
  const customConditions = conditionList(body.customConditions, issues);
  if (issues.length === 0 && enabled && triggers.length + customConditions.length === 0) {
    issues.push({ key: 'enabled', reason: NO_TRIGGER });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return { enabled, triggers, customConditions };
}

/** Validate an enable/disable request: `{ "enabled": true | false }` and nothing else. */
export function parseHandoffEnabledInput(body: Readonly<Record<string, unknown>>): boolean {
  const issues: ConfigIssue[] = [];
  for (const key of Object.keys(body)) {
    if (key !== 'enabled') issues.push({ key, reason: 'is not a recognised field' });
  }
  const enabled = enabledFlag(body.enabled, issues);
  if (issues.length > 0) throw new ValidationError(issues);
  return enabled;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface HandoffRow {
  enabled: boolean;
  triggers: HandoffTrigger[];
  custom_conditions: string[];
  updated_at: Date;
}

function fromRow(row: HandoffRow | undefined): HandoffSettings {
  if (row === undefined) return NEVER_CONFIGURED;
  return {
    enabled: row.enabled,
    triggers: HANDOFF_TRIGGERS.filter((trigger) => row.triggers.includes(trigger)),
    customConditions: row.custom_conditions,
    source: 'client',
    updatedAt: row.updated_at,
  };
}

const COLUMNS = 'enabled, triggers, custom_conditions, updated_at';

/** The tenant's handoff configuration: what the client saved, or the platform default. */
export async function readHandoffSettings(connection: Connection): Promise<HandoffSettings> {
  requireTenant(connection, 'readHandoffSettings');
  const result = await connection.query<HandoffRow>(
    `SELECT ${COLUMNS} FROM bot_handoff_settings WHERE tenant_id = app.current_tenant_id()`,
  );
  return fromRow(result.rows[0]);
}

async function write(connection: Connection, policy: HandoffPolicy): Promise<HandoffSettings> {
  const result = await connection.query<HandoffRow>(
    `INSERT INTO bot_handoff_settings (tenant_id, enabled, triggers, custom_conditions)
     VALUES (app.current_tenant_id(), $1, $2::text[], $3::text[])
     ON CONFLICT (tenant_id) DO UPDATE
       SET enabled           = EXCLUDED.enabled,
           triggers          = EXCLUDED.triggers,
           custom_conditions = EXCLUDED.custom_conditions,
           updated_at        = now()
     RETURNING ${COLUMNS}`,
    [policy.enabled, policy.triggers, policy.customConditions],
  );
  return fromRow(result.rows[0]);
}

/**
 * Validate and save the whole configuration. Takes the raw submission so that
 * validation is not a step a caller can skip. Applies to trigger evaluations
 * from the next message on, and to nothing already handed off (AC13).
 */
export async function saveHandoffSettings(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<HandoffSettings> {
  requireTenant(connection, 'saveHandoffSettings');
  return write(connection, parseHandoffInput(body));
}

/**
 * Enable or disable handoff, keeping whatever triggers are configured — the
 * platform default ones if the client never saved any. The desired state, not a
 * toggle, so a retried request cannot flip it back.
 *
 * The row is locked before it is read, so a concurrent save cannot slip a
 * trigger-less configuration in between the check and the write.
 */
export async function setHandoffEnabled(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<HandoffSettings> {
  requireTenant(connection, 'setHandoffEnabled');
  const enabled = parseHandoffEnabledInput(body);
  const current = await connection.query<HandoffRow>(
    `SELECT ${COLUMNS} FROM bot_handoff_settings WHERE tenant_id = app.current_tenant_id() FOR UPDATE`,
  );
  const settings = fromRow(current.rows[0]);
  if (enabled && settings.triggers.length + settings.customConditions.length === 0) {
    throw new ValidationError([{ key: 'enabled', reason: NO_TRIGGER }]);
  }
  return write(connection, { ...settings, enabled });
}

// ---------------------------------------------------------------------------
// What the rest of the platform consumes
// ---------------------------------------------------------------------------

/** The configuration the reply path evaluates, read inside its tenant-bound transaction. */
export async function handoffPolicyFor(connection: Connection): Promise<HandoffPolicy> {
  const { enabled, triggers, customConditions } = await readHandoffSettings(connection);
  return { enabled, triggers, customConditions };
}

/**
 * The handoff section of the reply prompt. The only renderer of it: P2's prompt
 * assembly must call this rather than phrase handoff itself.
 *
 * - Enabled: each selected built-in trigger and each of the client's own
 *   conditions, named, with the instruction to take the `"handoff"` action —
 *   the same action name `behaviorDirectives` uses — instead of answering when
 *   one holds (AC2–AC5). Client conditions are JSON-quoted, as behaviour rules'
 *   phrases are, so they read as data.
 * - Disabled: no person can take over, so the bot must not offer one, and
 *   anything that would call for a person — including a behaviour rule whose
 *   action is `"handoff"` — takes the `"fallback"` action instead (AC1).
 *
 * Pure and deterministic.
 */
export function handoffDirectives(policy: HandoffPolicy): string {
  if (!policy.enabled) {
    return (
      'No person from the business can take over this conversation, so do not offer or promise a transfer ' +
      'to one. Wherever a request would call for a person — including the "handoff" action of any rule — ' +
      'take the "fallback" action instead.'
    );
  }
  const lines = [
    'A person from the business can take over this conversation. Instead of answering, take the "handoff" ' +
      'action and name the condition that holds, whenever any of these conditions holds:',
    ...policy.triggers.map((trigger) => `- [${trigger}] ${HANDOFF_TRIGGER_DESCRIPTIONS[trigger]}`),
    ...policy.customConditions.map((condition) => `- [custom] ${JSON.stringify(condition)}`),
    'When none of them holds, keep answering yourself.',
  ];
  return lines.join('\n');
}

/**
 * Why a reply asked for a person: a built-in trigger, one of the client's own
 * conditions (by its text, which is also what is recorded, so later edits cannot
 * rewrite history), or a behaviour rule whose action is `handoff`.
 */
export type HandoffSignal =
  | { readonly kind: 'trigger'; readonly trigger: HandoffTrigger }
  | { readonly kind: 'custom_condition'; readonly condition: string }
  | { readonly kind: 'behavior_rule'; readonly ruleId: string };

/** What the reply path does with a handoff signal. */
export type HandoffDecision =
  | { readonly path: 'handoff'; readonly reason: HandoffSignal }
  | { readonly path: 'fallback'; readonly trigger: FallbackTrigger };

/**
 * Whether a handoff signal becomes a handoff, decided against the configuration
 * read in the same transaction. The single place `human-handoff.md` AC1 and
 * `behavior-rules-configuration.md`'s "routed per human-handoff.md" are decided:
 *
 * - Handoff disabled: never a handoff. The fallback path is taken, with the
 *   `out_of_scope` fallback message, whatever raised the signal (AC1).
 * - Enabled: a behaviour rule's handoff action is honoured; a built-in trigger or
 *   client condition is honoured only if it is currently configured. A signal
 *   naming a condition the client has since removed, or never selected, cannot
 *   pause a conversation — it takes the fallback path like any other message the
 *   bot declined to answer.
 */
export function resolveHandoffSignal(policy: HandoffPolicy, signal: HandoffSignal): HandoffDecision {
  const FALLBACK: HandoffDecision = { path: 'fallback', trigger: 'out_of_scope' };
  if (!policy.enabled) return FALLBACK;
  switch (signal.kind) {
    case 'behavior_rule':
      return { path: 'handoff', reason: signal };
    case 'trigger':
      return policy.triggers.includes(signal.trigger) ? { path: 'handoff', reason: signal } : FALLBACK;
    case 'custom_condition':
      return policy.customConditions.includes(signal.condition) ? { path: 'handoff', reason: signal } : FALLBACK;
  }
}

/**
 * The configuration as the client's screen shows it: what is in force, whether
 * it was saved or defaulted, and the triggers, descriptions, defaults, and limits
 * the form needs, so it has no reason to hard-code them.
 */
export function describeHandoffSettings(settings: HandoffSettings): {
  readonly enabled: boolean;
  readonly triggers: readonly HandoffTrigger[];
  readonly customConditions: readonly string[];
  readonly source: HandoffSource;
  readonly updatedAt: string | null;
  readonly options: {
    readonly triggers: typeof HANDOFF_TRIGGERS;
    readonly descriptions: typeof HANDOFF_TRIGGER_DESCRIPTIONS;
  };
  readonly platformDefault: { readonly enabled: boolean; readonly triggers: readonly HandoffTrigger[] };
  readonly limits: typeof HANDOFF_LIMITS;
} {
  return {
    enabled: settings.enabled,
    triggers: settings.triggers,
    customConditions: settings.customConditions,
    source: settings.source,
    updatedAt: settings.updatedAt?.toISOString() ?? null,
    options: { triggers: HANDOFF_TRIGGERS, descriptions: HANDOFF_TRIGGER_DESCRIPTIONS },
    platformDefault: { enabled: PLATFORM_DEFAULT_HANDOFF_ENABLED, triggers: PLATFORM_DEFAULT_HANDOFF_TRIGGERS },
    limits: HANDOFF_LIMITS,
  };
}
