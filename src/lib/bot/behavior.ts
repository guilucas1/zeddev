/**
 * The bot's behaviour rules — `behavior-rules-configuration.md`.
 *
 * Two mechanisms, both binding at once (the spec forbids treating them as
 * alternatives): discrete structured rules, each individually enabled, disabled,
 * edited, and deleted, and one block of freeform instructions text. Every rule
 * about what a valid rule is lives here, the migration's CHECK constraints mirror
 * the option lists and limits, and a test asserts the two agree.
 *
 * ## The shape of a structured rule
 *
 * The spec asks for prohibitions, obligations ("always X", "X before Y"),
 * conditional constraints ("X only when Y"), avoided topics, and rules whose
 * required action is a handoff or the fallback response — all without "code,
 * query language, or technical syntax". So a rule is a `kind` picked from a list,
 * one or two plain-language phrases, and an `action` picked from a list:
 *
 * | kind          | subject means        | condition means           |
 * | ------------- | -------------------- | ------------------------- |
 * | `never`       | what never to do     | (not allowed)             |
 * | `always`      | what always to do    | optional: "… before Y"    |
 * | `only_when`   | what to do           | required: "only when Y"   |
 * | `avoid_topic` | the topic to avoid   | (not allowed)             |
 *
 * A field that has no meaning for a kind is refused rather than stored, so the
 * client's view never shows a condition the bot silently ignores.
 *
 * ## How "scoped to that client only" is enforced
 *
 * As in `persona.ts`: no function takes a tenant id, every one takes a connection
 * already bound to a tenant, and row-level security hides every other tenant's
 * rows. A rule id from another tenant — guessed or leaked — therefore matches no
 * row, and is reported exactly as an id that never existed.
 *
 * ## How "the next response reflects the change" is enforced
 *
 * Nothing caches rules. The reply path reads them inside the transaction that
 * assembles the reply, so a change committed before that transaction starts —
 * including one made mid-conversation — is what the next reply obeys (AC9–AC13).
 */

import type { Connection } from '@zeddev/db';
import { ConflictError, NotFoundError, ValidationError, type ConfigIssue } from '@zeddev/errors';
import { characters, CONTROL, parseMultilineText, requireTenant } from './shared.ts';

/** Structured rule kinds. Mirrored by a CHECK constraint in migration 0008. */
export const RULE_KINDS = ['never', 'always', 'only_when', 'avoid_topic'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

/**
 * What the bot does when a rule stops it answering directly. Mirrored by a CHECK
 * constraint in migration 0008.
 *
 * `respond` — the rule only shapes the bot's own reply (it declines, asks for
 * what is missing, or steers away). `handoff` defers to `human-handoff.md`;
 * `fallback` defers to `fallback-response-behavior.md`. The names are rendered
 * literally into the instructions, so the reply path's output protocol can refer
 * to exactly these two action names.
 */
export const RULE_ACTIONS = ['respond', 'handoff', 'fallback'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

/** Which kinds require, allow, or refuse a condition. Mirrored by migration 0008. */
const CONDITION_BY_KIND: Readonly<Record<RuleKind, 'required' | 'optional' | 'refused'>> = {
  never: 'refused',
  always: 'optional',
  only_when: 'required',
  avoid_topic: 'refused',
};

/**
 * Limits, in characters (Unicode code points — what PostgreSQL counts).
 *
 * The spec sets no maximum and calls any limit an implementation concern. These
 * exist for one reason: every enabled rule and the freeform text are sent with
 * every reply, so their size is paid in model context on every message, on a
 * free-tier provider (`cost-efficient-operation.md`). A rule is a sentence, so 300
 * characters per phrase; 4000 for the freeform text, room for a page of policy;
 * and 100 rules, far more than a small business writes, enough that no client is
 * turned away while still bounding the prompt.
 */
export const BEHAVIOR_LIMITS = {
  subjectMaxLength: 300,
  conditionMaxLength: 300,
  freeformInstructionsMaxLength: 4000,
  maxRules: 100,
} as const;

/** A saved structured rule. */
export interface BehaviorRule {
  readonly id: string;
  readonly kind: RuleKind;
  readonly subject: string;
  readonly condition: string | null;
  readonly action: RuleAction;
  readonly enabled: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A validated rule definition, not yet saved. */
export interface RuleDefinition {
  readonly kind: RuleKind;
  readonly subject: string;
  readonly condition: string | null;
  readonly action: RuleAction;
}

/** Everything the tenant has configured under this spec. */
export interface BehaviorConfiguration {
  /** Every rule, enabled or not, in creation order. */
  readonly rules: readonly BehaviorRule[];
  readonly freeformInstructions: string | null;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuseUnknown(body: Readonly<Record<string, unknown>>, fields: readonly string[], issues: ConfigIssue[]): void {
  const known = new Set(fields);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) issues.push({ key, reason: 'is not a recognised field' });
  }
}

/** A one-line phrase, or `undefined` when absent or blank. Reasons never echo the value. */
function phrase(raw: unknown, key: string, max: number, issues: ConfigIssue[]): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    issues.push({ key, reason: 'must be a string' });
    return undefined;
  }
  const text = raw.normalize('NFC').trim();
  if (text === '') return undefined;
  if (CONTROL.test(text)) {
    issues.push({ key, reason: 'must be a single line of text' });
    return undefined;
  }
  if (characters(text) > max) {
    issues.push({ key, reason: `must be at most ${max} characters` });
    return undefined;
  }
  return text;
}

function ruleId(raw: unknown, issues: ConfigIssue[]): string {
  if (typeof raw === 'string' && UUID.test(raw)) return raw.toLowerCase();
  issues.push({ key: 'id', reason: raw === undefined || raw === null ? 'is required' : 'must be a rule id' });
  return '';
}

function enabledFlag(raw: unknown, issues: ConfigIssue[], required: boolean): boolean {
  if (raw === undefined || raw === null) {
    if (required) issues.push({ key: 'enabled', reason: 'is required' });
    return true;
  }
  if (typeof raw !== 'boolean') issues.push({ key: 'enabled', reason: 'must be true or false' });
  return raw === true;
}

function definition(body: Readonly<Record<string, unknown>>, issues: ConfigIssue[]): RuleDefinition {
  let kind: RuleKind = 'never';
  const rawKind = body.kind;
  const kindValid = typeof rawKind === 'string' && (RULE_KINDS as readonly string[]).includes(rawKind);
  if (rawKind === undefined || rawKind === null) {
    issues.push({ key: 'kind', reason: 'is required' });
  } else if (!kindValid) {
    issues.push({ key: 'kind', reason: `must be one of: ${RULE_KINDS.join(', ')}` });
  } else {
    kind = rawKind as RuleKind;
  }

  const subject = phrase(body.subject, 'subject', BEHAVIOR_LIMITS.subjectMaxLength, issues);
  if (subject === undefined && !issues.some((issue) => issue.key === 'subject')) {
    issues.push({ key: 'subject', reason: 'is required' });
  }

  const condition = phrase(body.condition, 'condition', BEHAVIOR_LIMITS.conditionMaxLength, issues);
  if (kindValid) {
    const rule = CONDITION_BY_KIND[kind];
    if (rule === 'required' && condition === undefined && !issues.some((issue) => issue.key === 'condition')) {
      issues.push({ key: 'condition', reason: `is required when kind is ${kind}` });
    } else if (rule === 'refused' && condition !== undefined) {
      issues.push({ key: 'condition', reason: `is not used when kind is ${kind}` });
    }
  }

  let action: RuleAction = 'respond';
  const rawAction = body.action;
  if (rawAction !== undefined && rawAction !== null) {
    if (typeof rawAction === 'string' && (RULE_ACTIONS as readonly string[]).includes(rawAction)) {
      action = rawAction as RuleAction;
    } else {
      issues.push({ key: 'action', reason: `must be one of: ${RULE_ACTIONS.join(', ')}` });
    }
  }
  // "Always hand off" is a handoff trigger, configured under human-handoff.md.
  if (kindValid && kind === 'always' && action !== 'respond') {
    issues.push({ key: 'action', reason: 'must be respond when kind is always' });
  }

  return { kind, subject: subject ?? '', condition: condition ?? null, action };
}

/** The fields a new rule may carry. */
export const RULE_CREATE_FIELDS = ['kind', 'subject', 'condition', 'action', 'enabled'] as const;
/** The fields an edit carries: the rule's id and its whole new definition. */
export const RULE_UPDATE_FIELDS = ['id', 'kind', 'subject', 'condition', 'action'] as const;

/**
 * Validate a new rule, reporting every problem at once. A rule is enabled on
 * creation unless the client says otherwise.
 */
export function parseRuleCreateInput(
  body: Readonly<Record<string, unknown>>,
): RuleDefinition & { readonly enabled: boolean } {
  const issues: ConfigIssue[] = [];
  refuseUnknown(body, RULE_CREATE_FIELDS, issues);
  const parsed = definition(body, issues);
  const enabled = enabledFlag(body.enabled, issues, false);
  if (issues.length > 0) throw new ValidationError(issues);
  return { ...parsed, enabled };
}

/**
 * Validate an edit. An edit replaces the rule's whole definition — an optional
 * field left out is cleared, not kept — and leaves its enabled state alone, which
 * has its own operation.
 */
export function parseRuleUpdateInput(
  body: Readonly<Record<string, unknown>>,
): RuleDefinition & { readonly id: string } {
  const issues: ConfigIssue[] = [];
  refuseUnknown(body, RULE_UPDATE_FIELDS, issues);
  const id = ruleId(body.id, issues);
  const parsed = definition(body, issues);
  if (issues.length > 0) throw new ValidationError(issues);
  return { ...parsed, id };
}

function parseToggleInput(body: Readonly<Record<string, unknown>>): { readonly id: string; readonly enabled: boolean } {
  const issues: ConfigIssue[] = [];
  refuseUnknown(body, ['id', 'enabled'], issues);
  const id = ruleId(body.id, issues);
  const enabled = enabledFlag(body.enabled, issues, true);
  if (issues.length > 0) throw new ValidationError(issues);
  return { id, enabled };
}

function parseIdInput(body: Readonly<Record<string, unknown>>): string {
  const issues: ConfigIssue[] = [];
  refuseUnknown(body, ['id'], issues);
  const id = ruleId(body.id, issues);
  if (issues.length > 0) throw new ValidationError(issues);
  return id;
}

/** Validate freeform instructions. Blank means cleared: there is one representation of it. */
export function parseBehaviorInstructionsInput(body: Readonly<Record<string, unknown>>): string | null {
  const issues: ConfigIssue[] = [];
  refuseUnknown(body, ['freeformInstructions'], issues);
  let text: string | null = null;
  const raw = body.freeformInstructions;
  if (raw === undefined) {
    issues.push({ key: 'freeformInstructions', reason: 'is required (send null or an empty string to clear it)' });
  } else {
    text = parseMultilineText(raw, 'freeformInstructions', BEHAVIOR_LIMITS.freeformInstructionsMaxLength, issues);
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return text;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface RuleRow {
  id: string;
  kind: RuleKind;
  subject: string;
  condition: string | null;
  action: RuleAction;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

const RULE_COLUMNS = 'id, kind, subject, condition, action, enabled, created_at, updated_at';

function fromRow(row: RuleRow): BehaviorRule {
  return {
    id: row.id,
    kind: row.kind,
    subject: row.subject,
    condition: row.condition,
    action: row.action,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}


/**
 * Report a rule that is not this tenant's as absent. Identical for an id that
 * never existed, one that was deleted, and one owned by another tenant, so the
 * answer reveals nothing about ids outside the caller's own tenant.
 */
function ruleNotFound(): NotFoundError {
  return new NotFoundError('bot.behavior_rule');
}

/** The tenant's whole behaviour configuration (AC15). */
export async function readBehaviorRules(connection: Connection): Promise<BehaviorConfiguration> {
  requireTenant(connection, 'readBehaviorRules');
  const rules = await connection.query<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM bot_behavior_rules
      WHERE tenant_id = app.current_tenant_id()
      ORDER BY position`,
  );
  const instructions = await connection.query<{ freeform_instructions: string | null }>(
    `SELECT freeform_instructions FROM bot_behavior_instructions WHERE tenant_id = app.current_tenant_id()`,
  );
  return {
    rules: rules.rows.map(fromRow),
    freeformInstructions: instructions.rows[0]?.freeform_instructions ?? null,
  };
}

/**
 * Validate and add a rule.
 *
 * The rule count is checked under a per-tenant transaction lock, so two
 * concurrent creates cannot both see 99 rules and both insert. The lock is an
 * advisory one keyed on the tenant: a hash collision between two tenants only
 * serialises their rule creation, it never lets one see the other's rows.
 */
export async function createBehaviorRule(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<BehaviorRule> {
  requireTenant(connection, 'createBehaviorRule');
  const input = parseRuleCreateInput(body);
  await connection.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('bot.behavior_rules:' || app.current_tenant_id()::text, 0))`,
  );
  const count = await connection.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM bot_behavior_rules WHERE tenant_id = app.current_tenant_id()`,
  );
  if (count.rows[0]!.n >= BEHAVIOR_LIMITS.maxRules) {
    throw new ConflictError(`A business may have at most ${BEHAVIOR_LIMITS.maxRules} behaviour rules.`, {
      code: 'bot.behavior_rules_limit',
    });
  }
  const result = await connection.query<RuleRow>(
    `INSERT INTO bot_behavior_rules (tenant_id, kind, subject, condition, action, enabled)
     VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5)
     RETURNING ${RULE_COLUMNS}`,
    [input.kind, input.subject, input.condition, input.action, input.enabled],
  );
  return fromRow(result.rows[0]!);
}

/** Validate and replace one rule's definition (AC11). Its enabled state is unchanged. */
export async function updateBehaviorRule(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<BehaviorRule> {
  requireTenant(connection, 'updateBehaviorRule');
  const input = parseRuleUpdateInput(body);
  const result = await connection.query<RuleRow>(
    `UPDATE bot_behavior_rules
        SET kind = $2, subject = $3, condition = $4, action = $5, updated_at = now()
      WHERE id = $1 AND tenant_id = app.current_tenant_id()
      RETURNING ${RULE_COLUMNS}`,
    [input.id, input.kind, input.subject, input.condition, input.action],
  );
  const row = result.rows[0];
  if (row === undefined) throw ruleNotFound();
  return fromRow(row);
}

/** Enable or disable one rule without deleting it (AC9). Idempotent. */
export async function setBehaviorRuleEnabled(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<BehaviorRule> {
  requireTenant(connection, 'setBehaviorRuleEnabled');
  const input = parseToggleInput(body);
  const result = await connection.query<RuleRow>(
    `UPDATE bot_behavior_rules
        SET enabled    = $2,
            updated_at = CASE WHEN enabled = $2 THEN updated_at ELSE now() END
      WHERE id = $1 AND tenant_id = app.current_tenant_id()
      RETURNING ${RULE_COLUMNS}`,
    [input.id, input.enabled],
  );
  const row = result.rows[0];
  if (row === undefined) throw ruleNotFound();
  return fromRow(row);
}

/** Delete one rule (AC10). Deleting a rule that is not there is "not found", not success. */
export async function deleteBehaviorRule(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  requireTenant(connection, 'deleteBehaviorRule');
  const id = parseIdInput(body);
  const result = await connection.query(
    `DELETE FROM bot_behavior_rules WHERE id = $1 AND tenant_id = app.current_tenant_id()`,
    [id],
  );
  if (result.rowCount === 0) throw ruleNotFound();
}

/** Validate and replace the freeform instructions (AC12); a blank value clears them. */
export async function saveBehaviorInstructions(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<string | null> {
  requireTenant(connection, 'saveBehaviorInstructions');
  const text = parseBehaviorInstructionsInput(body);
  return writeInstructions(connection, text);
}

/** Clear the freeform instructions, leaving every structured rule untouched. */
export async function clearBehaviorInstructions(connection: Connection): Promise<null> {
  requireTenant(connection, 'clearBehaviorInstructions');
  await writeInstructions(connection, null);
  return null;
}

async function writeInstructions(connection: Connection, text: string | null): Promise<string | null> {
  const result = await connection.query<{ freeform_instructions: string | null }>(
    `INSERT INTO bot_behavior_instructions (tenant_id, freeform_instructions)
     VALUES (app.current_tenant_id(), $1)
     ON CONFLICT (tenant_id) DO UPDATE
       SET freeform_instructions = EXCLUDED.freeform_instructions,
           updated_at            = now()
     RETURNING freeform_instructions`,
    [text],
  );
  return result.rows[0]!.freeform_instructions;
}

// ---------------------------------------------------------------------------
// What the rest of the platform consumes
// ---------------------------------------------------------------------------

const ACTION_DIRECTIVES: Readonly<Record<RuleAction, string>> = {
  respond: '',
  handoff:
    ' When this rule applies, do not answer the constrained request yourself: take the "handoff" action ' +
    'so a person from the business takes over.',
  fallback:
    ' When this rule applies, do not answer the constrained request yourself: take the "fallback" action ' +
    'so the business\'s fallback response is sent.',
};

function ruleDirective(rule: BehaviorRule): string {
  const subject = JSON.stringify(rule.subject);
  let sentence: string;
  switch (rule.kind) {
    case 'never':
      sentence = `Never do this: ${subject}.`;
      break;
    case 'always':
      sentence =
        rule.condition === null
          ? `Always do this: ${subject}.`
          : `Always do this: ${subject} — and do it before this: ${JSON.stringify(rule.condition)}.`;
      break;
    case 'only_when':
      sentence =
        `Do this only when the condition holds: ${subject}. Condition: ${JSON.stringify(rule.condition)}. ` +
        'If the condition does not yet hold, do not do it; ask for what is missing or decline politely.';
      break;
    case 'avoid_topic':
      sentence = `Do not discuss or engage with this topic: ${subject}. Politely decline if asked about it.`;
      break;
  }
  return `- ${sentence}${ACTION_DIRECTIVES[rule.action]}`;
}

/**
 * The behaviour-rules section of the bot's instructions, or `undefined` when the
 * tenant has no enabled rule and no freeform text — AC1's "no constraint beyond
 * platform defaults" is the section being absent, not present and empty.
 *
 * Only *enabled* rules are rendered (AC9); a deleted rule is not read at all
 * (AC10). Both mechanisms appear together when both are set (AC6), structured
 * rules first and the client's own words after, with no precedence between them:
 * the spec treats both as binding at once.
 *
 * Client phrases are rendered JSON-quoted. Validation already refuses line breaks
 * in them, and quoting keeps a phrase readable as data even when it contains
 * words that look like instructions of their own.
 *
 * Pure and deterministic: the only input is what the tenant's own connection read.
 */
export function behaviorDirectives(configuration: BehaviorConfiguration): string | undefined {
  const enabled = configuration.rules.filter((rule) => rule.enabled);
  const sections: string[] = [];
  if (enabled.length > 0) {
    sections.push(
      [
        'The business set these rules. Follow every one of them in every reply, for every customer:',
        ...enabled.map(ruleDirective),
      ].join('\n'),
    );
  }
  if (configuration.freeformInstructions !== null) {
    sections.push(
      [
        enabled.length > 0
          ? 'The business also gave these behaviour instructions, which bind together with the rules above:'
          : 'The business gave these behaviour instructions. Follow them in every reply, for every customer:',
        configuration.freeformInstructions,
      ].join('\n'),
    );
  }
  return sections.length === 0 ? undefined : sections.join('\n\n');
}

/** One rule as the client's configuration screen shows it. */
export function describeBehaviorRule(rule: BehaviorRule): {
  readonly id: string;
  readonly kind: RuleKind;
  readonly subject: string;
  readonly condition: string | null;
  readonly action: RuleAction;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
} {
  return {
    id: rule.id,
    kind: rule.kind,
    subject: rule.subject,
    condition: rule.condition,
    action: rule.action,
    enabled: rule.enabled,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

/**
 * The whole configuration as the client's screen shows it (AC15): every rule with
 * its enabled state, the freeform text, and the options and limits the form needs,
 * so the form has no reason to hard-code them.
 */
export function describeBehaviorRules(configuration: BehaviorConfiguration): {
  readonly rules: ReturnType<typeof describeBehaviorRule>[];
  readonly freeformInstructions: string | null;
  readonly limits: typeof BEHAVIOR_LIMITS;
  readonly options: {
    readonly kinds: typeof RULE_KINDS;
    readonly actions: typeof RULE_ACTIONS;
    readonly condition: typeof CONDITION_BY_KIND;
  };
} {
  return {
    rules: configuration.rules.map(describeBehaviorRule),
    freeformInstructions: configuration.freeformInstructions,
    limits: BEHAVIOR_LIMITS,
    options: { kinds: RULE_KINDS, actions: RULE_ACTIONS, condition: CONDITION_BY_KIND },
  };
}
