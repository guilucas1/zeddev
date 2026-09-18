/**
 * The client's fallback messages — `fallback-response-behavior.md`.
 *
 * What the bot sends when it cannot produce a good answer and handoff is not the
 * path taken. Every rule about which text that is lives here: the trigger
 * vocabulary, the length limit, the platform defaults, and the resolution order.
 * The reply path and the client's preview both call `resolveFallbackMessage`, so
 * a preview cannot show one thing while an end-customer receives another (AC12).
 *
 * ## Literal text, never generated
 *
 * The spec requires a fallback to go out even when the AI step itself has failed
 * (AC5), which is only possible if the text already exists. So a fallback message
 * is stored exactly as the client wrote it and sent as-is. It reflects the
 * client's persona and tone (AC8) because the client wrote it in that voice; it is
 * deliberately not rewritten by the model on the way out, because a fallback
 * whose delivery depends on the component whose failure triggered it would be
 * silence exactly when it is needed. IMPLEMENTATION_PLAN.md §3 records this so
 * nobody "improves" it into a generated reply.
 *
 * ## Resolution
 *
 * For each trigger: the trigger's own message, else the shared message, else the
 * platform default for that trigger. A single shared message is therefore a
 * complete configuration (AC4), distinct per-trigger messages are too (AC3), and
 * a trigger the client left alone still gets a non-blank reply (AC2).
 *
 * ## Scope and freshness
 *
 * As everywhere in `@zeddev/bot`: no function takes a tenant id, the SQL writes
 * `app.current_tenant_id()`, and row-level security hides every other tenant's
 * row. Nothing caches a configuration, so a save committed before the reply's
 * transaction starts is what that reply sends (AC11).
 */

import type { Connection } from '@zeddev/db';
import { ValidationError, type ConfigIssue } from '@zeddev/errors';
import { parseMultilineText, requireTenant } from './shared.ts';

/**
 * Why the bot could not answer. Each has its own optional message, stored in its
 * own column of `bot_fallback_messages` (migration 0009); a test asserts this list
 * and those columns agree.
 *
 * - `ai_error` — generation failed or errored outright.
 * - `low_confidence` — an answer was produced but is not good enough to send.
 * - `out_of_scope` — the message is outside what the client set the bot up to handle.
 */
export const FALLBACK_TRIGGERS = ['ai_error', 'low_confidence', 'out_of_scope'] as const;
export type FallbackTrigger = (typeof FALLBACK_TRIGGERS)[number];

/**
 * Maximum message length, in characters (Unicode code points), matching the
 * migration's CHECK constraints.
 *
 * A thousand: a fallback is an apology plus, at most, a way to reach the business
 * or a required disclaimer. WhatsApp itself accepts about four times this in one
 * text message, so the limit is about what a fallback is for, not the transport.
 */
export const FALLBACK_LIMITS = {
  messageMaxLength: 1000,
} as const;

/**
 * What the platform sends for a trigger the client has configured nothing for.
 *
 * Neutral in register and free of any claim about the business, because it is
 * sent on behalf of a business the platform knows nothing about. English until
 * language configuration lands (`language-configuration.md` requires the fallback
 * be rendered in the configured language); these then become per-language.
 */
export const PLATFORM_DEFAULT_FALLBACK_MESSAGES: Readonly<Record<FallbackTrigger, string>> = {
  ai_error: "Sorry, I'm having trouble answering right now. Please try again in a little while.",
  low_confidence: "Sorry, I'm not sure I can answer that accurately. Could you rephrase it or add a bit more detail?",
  out_of_scope: "Sorry, that's not something I can help with here.",
};

/** The request fields `saveFallbackMessages` accepts. Anything else is refused by name. */
export const FALLBACK_FIELDS = ['sharedMessage', 'triggerMessages'] as const;

/** A validated configuration. `null` means "not configured". */
export interface FallbackInput {
  readonly sharedMessage: string | null;
  readonly triggerMessages: Readonly<Record<FallbackTrigger, string | null>>;
}

/** The tenant's saved configuration. A never-configured tenant has every message `null`. */
export interface FallbackMessages extends FallbackInput {
  /** When the configuration was last saved, or `null` if it never has been (or was cleared). */
  readonly updatedAt: Date | null;
}

/** Where a resolved fallback's text came from. */
export type FallbackSource = 'trigger' | 'shared' | 'platform_default';

/** The text the bot sends for one trigger, and why it is that text. */
export interface ResolvedFallback {
  readonly trigger: FallbackTrigger;
  readonly message: string;
  readonly source: FallbackSource;
}

const NOTHING_CONFIGURED: FallbackMessages = {
  sharedMessage: null,
  triggerMessages: { ai_error: null, low_confidence: null, out_of_scope: null },
  updatedAt: null,
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate and normalise a fallback submission, reporting every problem at once.
 *
 * A save replaces the whole configuration, so a message left out means "not
 * configured", not "leave as it was": a form that submits what it shows cannot
 * resurrect a message the client just removed. A blank message is the same as an
 * absent one.
 */
export function parseFallbackInput(body: Readonly<Record<string, unknown>>): FallbackInput {
  const issues: ConfigIssue[] = [];
  const known = new Set<string>(FALLBACK_FIELDS);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) issues.push({ key, reason: 'is not a recognised field' });
  }

  const max = FALLBACK_LIMITS.messageMaxLength;
  const sharedMessage = parseMultilineText(body.sharedMessage, 'sharedMessage', max, issues);

  const triggerMessages: Record<FallbackTrigger, string | null> = { ai_error: null, low_confidence: null, out_of_scope: null };
  const raw = body.triggerMessages;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      issues.push({
        key: 'triggerMessages',
        reason: `must be an object keyed by trigger (${FALLBACK_TRIGGERS.join(', ')})`,
      });
    } else {
      const byTrigger = raw as Readonly<Record<string, unknown>>;
      const triggers = new Set<string>(FALLBACK_TRIGGERS);
      for (const key of Object.keys(byTrigger)) {
        if (!triggers.has(key)) {
          issues.push({
            key: `triggerMessages.${key}`,
            reason: `is not a recognised trigger (expected one of: ${FALLBACK_TRIGGERS.join(', ')})`,
          });
        }
      }
      for (const trigger of FALLBACK_TRIGGERS) {
        triggerMessages[trigger] = parseMultilineText(byTrigger[trigger], `triggerMessages.${trigger}`, max, issues);
      }
    }
  }

  if (issues.length > 0) throw new ValidationError(issues);
  return { sharedMessage, triggerMessages };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface FallbackRow {
  shared_message: string | null;
  ai_error_message: string | null;
  low_confidence_message: string | null;
  out_of_scope_message: string | null;
  updated_at: Date;
}

const COLUMNS = 'shared_message, ai_error_message, low_confidence_message, out_of_scope_message, updated_at';

function fromRow(row: FallbackRow | undefined): FallbackMessages {
  if (row === undefined) return NOTHING_CONFIGURED;
  return {
    sharedMessage: row.shared_message,
    triggerMessages: {
      ai_error: row.ai_error_message,
      low_confidence: row.low_confidence_message,
      out_of_scope: row.out_of_scope_message,
    },
    updatedAt: row.updated_at,
  };
}

/** The tenant's fallback configuration; every message `null` if it has configured none. */
export async function readFallbackMessages(connection: Connection): Promise<FallbackMessages> {
  requireTenant(connection, 'readFallbackMessages');
  const result = await connection.query<FallbackRow>(
    `SELECT ${COLUMNS} FROM bot_fallback_messages WHERE tenant_id = app.current_tenant_id()`,
  );
  return fromRow(result.rows[0]);
}

/**
 * Validate and save the tenant's fallback configuration, replacing whatever was
 * there (AC11). A submission with every message blank returns the tenant to the
 * platform defaults by deleting the row.
 *
 * Takes the raw submission rather than a `FallbackInput` so that validation is
 * not a step a caller can skip.
 */
export async function saveFallbackMessages(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<FallbackMessages> {
  requireTenant(connection, 'saveFallbackMessages');
  const input = parseFallbackInput(body);
  const { ai_error, low_confidence, out_of_scope } = input.triggerMessages;
  if ([input.sharedMessage, ai_error, low_confidence, out_of_scope].every((message) => message === null)) {
    await connection.query(`DELETE FROM bot_fallback_messages WHERE tenant_id = app.current_tenant_id()`);
    return NOTHING_CONFIGURED;
  }
  const result = await connection.query<FallbackRow>(
    `INSERT INTO bot_fallback_messages
       (tenant_id, shared_message, ai_error_message, low_confidence_message, out_of_scope_message)
     VALUES (app.current_tenant_id(), $1, $2, $3, $4)
     ON CONFLICT (tenant_id) DO UPDATE
       SET shared_message         = EXCLUDED.shared_message,
           ai_error_message       = EXCLUDED.ai_error_message,
           low_confidence_message = EXCLUDED.low_confidence_message,
           out_of_scope_message   = EXCLUDED.out_of_scope_message,
           updated_at             = now()
     RETURNING ${COLUMNS}`,
    [input.sharedMessage, ai_error, low_confidence, out_of_scope],
  );
  return fromRow(result.rows[0]);
}

// ---------------------------------------------------------------------------
// What the rest of the platform consumes
// ---------------------------------------------------------------------------

/**
 * The text to send for `trigger`: the trigger's own message, else the shared
 * message, else the platform default. Never blank (AC2).
 *
 * Pure, and the only resolver: the reply path and the preview both call it.
 */
export function resolveFallbackMessage(configuration: FallbackInput, trigger: FallbackTrigger): ResolvedFallback {
  const own = configuration.triggerMessages[trigger];
  if (own !== null) return { trigger, message: own, source: 'trigger' };
  if (configuration.sharedMessage !== null) return { trigger, message: configuration.sharedMessage, source: 'shared' };
  return { trigger, message: PLATFORM_DEFAULT_FALLBACK_MESSAGES[trigger], source: 'platform_default' };
}

/**
 * The fallback the reply path sends for `trigger`, read inside the caller's
 * tenant-bound transaction.
 *
 * Needs no AI provider, only this tenant's row — which is what makes AC5 ("the
 * AI generation step fails outright … the end-customer still receives a fallback
 * response") structural rather than a matter of error handling.
 */
export async function fallbackMessageFor(connection: Connection, trigger: FallbackTrigger): Promise<ResolvedFallback> {
  return resolveFallbackMessage(await readFallbackMessages(connection), trigger);
}

/** What the end-customer would receive for every trigger (AC12). */
export function previewFallbackMessages(configuration: FallbackInput): readonly ResolvedFallback[] {
  return FALLBACK_TRIGGERS.map((trigger) => resolveFallbackMessage(configuration, trigger));
}

/**
 * Preview an unsaved submission: validate it exactly as a save would and show
 * what each trigger would send, without storing anything.
 *
 * The spec asks for a preview "before they take effect", and a save takes effect
 * on the next message, so previewing only what is already saved would show the
 * client their change after end-customers could already receive it.
 */
export function previewFallbackDraft(body: Readonly<Record<string, unknown>>): readonly ResolvedFallback[] {
  return previewFallbackMessages(parseFallbackInput(body));
}

/**
 * The configuration as the client's screen shows it: the saved messages, what
 * each trigger actually resolves to, and the triggers, defaults, and limit the
 * form needs, so it has no reason to hard-code them.
 */
export function describeFallbackMessages(configuration: FallbackMessages): {
  readonly sharedMessage: string | null;
  readonly triggerMessages: Readonly<Record<FallbackTrigger, string | null>>;
  readonly updatedAt: string | null;
  readonly preview: readonly ResolvedFallback[];
  readonly triggers: typeof FALLBACK_TRIGGERS;
  readonly platformDefaults: typeof PLATFORM_DEFAULT_FALLBACK_MESSAGES;
  readonly limits: typeof FALLBACK_LIMITS;
} {
  return {
    sharedMessage: configuration.sharedMessage,
    triggerMessages: configuration.triggerMessages,
    updatedAt: configuration.updatedAt?.toISOString() ?? null,
    preview: previewFallbackMessages(configuration),
    triggers: FALLBACK_TRIGGERS,
    platformDefaults: PLATFORM_DEFAULT_FALLBACK_MESSAGES,
    limits: FALLBACK_LIMITS,
  };
}
