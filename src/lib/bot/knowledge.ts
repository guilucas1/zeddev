/**
 * The bot's business knowledge — `business-knowledge-configuration.md`.
 *
 * Two sources, usable alone or together (the spec forbids forcing a choice):
 * freeform entries the client writes in their own words, and uploaded
 * documents. This module owns the freeform half — what a valid entry is, the
 * add/edit/remove lifecycle, the listing, whether knowledge counts as
 * configured, and the instruction text the reply path renders from it. Uploaded
 * documents join the same listing and the same "configured" answer when upload
 * lands; a knowledge area that answered "configured" from entries alone would
 * then be wrong for a client who only uploads, so both answers are computed here
 * and nowhere else.
 *
 * ## What an entry is
 *
 * One block of multi-line text, with no title, category, or template — AC2's
 * "written in their own words, without any required structure". An edit replaces
 * the text in place, keeping the entry's id and its position in the list.
 *
 * ## How "scoped to that client only" is enforced
 *
 * As everywhere in `@zeddev/bot`: no function takes a tenant id, every one takes
 * a connection already bound to a tenant, and row-level security hides every
 * other tenant's rows. Another tenant's entry id — guessed or leaked — matches no
 * row and is reported exactly as an id that never existed (AC11).
 *
 * ## How "the next response reflects the change" is enforced
 *
 * Nothing caches knowledge. The reply path reads it inside the transaction that
 * assembles the reply, so an edit or removal committed before that transaction
 * starts is what the next reply draws on (AC7, AC8), with no publish step.
 *
 * ## Knowledge never gates readiness
 *
 * AC9: an empty knowledge area never blocks going live. That is structural —
 * `app.bot_readiness_unmet` has no knowledge clause and the table has no
 * readiness trigger — and a test asserts it. AC10's "recommended but not
 * required" is `describeKnowledgeStatus`, which the bot status screen shows next
 * to, never inside, the readiness conditions.
 */

import type { Connection } from '@zeddev/db';
import { ConflictError, NotFoundError, ValidationError, type ConfigIssue } from '@zeddev/errors';
import { parseMultilineText, requireTenant } from './shared.ts';

/**
 * Limits, in characters (Unicode code points — what PostgreSQL counts).
 *
 * The spec assumes no hard limit and leaves any to implementation. 4000 characters
 * is a page of policy or a long FAQ answer per entry, and 100 entries is far more
 * than a small business writes by hand — documents are where bulk knowledge
 * belongs. What one prompt may carry is bounded separately, by
 * `KNOWLEDGE_SELECTION.promptBudget`, which must not fall below `entryMaxLength`.
 * The entry limit is mirrored by a CHECK in migration 0012.
 */
export const KNOWLEDGE_LIMITS = {
  entryMaxLength: 4000,
  maxEntries: 100,
} as const;

/** A saved freeform knowledge entry. */
export interface KnowledgeEntry {
  readonly id: string;
  readonly content: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Everything the tenant has configured under this spec. */
export interface KnowledgeConfiguration {
  /** Every freeform entry, in creation order. */
  readonly entries: readonly KnowledgeEntry[];
  /**
   * Set only by `selectKnowledge`, when `entries` is a selection from a larger
   * whole: the prompt must then say so (see `knowledgeDirectives`).
   */
  readonly partial?: boolean;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The fields a new entry carries. */
export const KNOWLEDGE_ENTRY_CREATE_FIELDS = ['content'] as const;
/** The fields an edit carries: the entry's id and its whole new text. */
export const KNOWLEDGE_ENTRY_UPDATE_FIELDS = ['id', 'content'] as const;

function refuseUnknown(body: Readonly<Record<string, unknown>>, fields: readonly string[], issues: ConfigIssue[]): void {
  const known = new Set(fields);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) issues.push({ key, reason: 'is not a recognised field' });
  }
}

function entryId(raw: unknown, issues: ConfigIssue[]): string {
  if (typeof raw === 'string' && UUID.test(raw)) return raw.toLowerCase();
  issues.push({ key: 'id', reason: raw === undefined || raw === null ? 'is required' : 'must be a knowledge entry id' });
  return '';
}

/**
 * The entry's text. Required and non-blank: a blank entry would count as
 * "configured" while telling the bot nothing, and clearing an entry is what
 * delete is for. Reasons never echo the value — it is client content.
 */
function entryContent(raw: unknown, issues: ConfigIssue[]): string {
  const before = issues.length;
  const text = parseMultilineText(raw, 'content', KNOWLEDGE_LIMITS.entryMaxLength, issues);
  if (text === null && issues.length === before) issues.push({ key: 'content', reason: 'is required' });
  return text ?? '';
}

/** Validate a new entry, reporting every problem at once. */
export function parseKnowledgeEntryCreateInput(body: Readonly<Record<string, unknown>>): { readonly content: string } {
  const issues: ConfigIssue[] = [];
  refuseUnknown(body, KNOWLEDGE_ENTRY_CREATE_FIELDS, issues);
  const content = entryContent(body.content, issues);
  if (issues.length > 0) throw new ValidationError(issues);
  return { content };
}

/** Validate an edit: the entry's id and its whole replacement text. */
export function parseKnowledgeEntryUpdateInput(
  body: Readonly<Record<string, unknown>>,
): { readonly id: string; readonly content: string } {
  const issues: ConfigIssue[] = [];
  refuseUnknown(body, KNOWLEDGE_ENTRY_UPDATE_FIELDS, issues);
  const id = entryId(body.id, issues);
  const content = entryContent(body.content, issues);
  if (issues.length > 0) throw new ValidationError(issues);
  return { id, content };
}

function parseIdInput(body: Readonly<Record<string, unknown>>): string {
  const issues: ConfigIssue[] = [];
  refuseUnknown(body, ['id'], issues);
  const id = entryId(body.id, issues);
  if (issues.length > 0) throw new ValidationError(issues);
  return id;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface EntryRow {
  id: string;
  content: string;
  created_at: Date;
  updated_at: Date;
}

const ENTRY_COLUMNS = 'id, content, created_at, updated_at';

function fromRow(row: EntryRow): KnowledgeEntry {
  return { id: row.id, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at };
}

/**
 * Report an entry that is not this tenant's as absent. Identical for an id that
 * never existed, one that was deleted, and one owned by another tenant.
 */
function entryNotFound(): NotFoundError {
  return new NotFoundError('bot.knowledge_entry');
}

/** The tenant's whole knowledge configuration (AC1, AC12). */
export async function readKnowledge(connection: Connection): Promise<KnowledgeConfiguration> {
  requireTenant(connection, 'readKnowledge');
  const entries = await connection.query<EntryRow>(
    `SELECT ${ENTRY_COLUMNS} FROM bot_knowledge_entries
      WHERE tenant_id = app.current_tenant_id()
      ORDER BY position`,
  );
  return { entries: entries.rows.map(fromRow) };
}

/**
 * Validate and add an entry (AC2). The returned entry is the confirmation: it
 * exists once this commits, and the next reply reads it.
 *
 * The entry count is checked under a per-tenant transaction lock, so two
 * concurrent adds cannot both see 99 entries and both insert. The lock is an
 * advisory one keyed on the tenant: a hash collision between two tenants only
 * serialises their additions, it never lets one see the other's rows.
 */
export async function createKnowledgeEntry(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<KnowledgeEntry> {
  requireTenant(connection, 'createKnowledgeEntry');
  const input = parseKnowledgeEntryCreateInput(body);
  await connection.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('bot.knowledge_entries:' || app.current_tenant_id()::text, 0))`,
  );
  const count = await connection.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM bot_knowledge_entries WHERE tenant_id = app.current_tenant_id()`,
  );
  if (count.rows[0]!.n >= KNOWLEDGE_LIMITS.maxEntries) {
    throw new ConflictError(`A business may have at most ${KNOWLEDGE_LIMITS.maxEntries} knowledge entries.`, {
      code: 'bot.knowledge_entries_limit',
    });
  }
  const result = await connection.query<EntryRow>(
    `INSERT INTO bot_knowledge_entries (tenant_id, content)
     VALUES (app.current_tenant_id(), $1)
     RETURNING ${ENTRY_COLUMNS}`,
    [input.content],
  );
  return fromRow(result.rows[0]!);
}

/** Validate and replace one entry's text (AC7). Its id and position are kept. */
export async function updateKnowledgeEntry(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<KnowledgeEntry> {
  requireTenant(connection, 'updateKnowledgeEntry');
  const input = parseKnowledgeEntryUpdateInput(body);
  const result = await connection.query<EntryRow>(
    `UPDATE bot_knowledge_entries
        SET content    = $2,
            updated_at = CASE WHEN content = $2 THEN updated_at ELSE now() END
      WHERE id = $1 AND tenant_id = app.current_tenant_id()
      RETURNING ${ENTRY_COLUMNS}`,
    [input.id, input.content],
  );
  const row = result.rows[0];
  if (row === undefined) throw entryNotFound();
  return fromRow(row);
}

/** Remove one entry (AC7, AC8). Removing an entry that is not there is "not found", not success. */
export async function deleteKnowledgeEntry(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<void> {
  requireTenant(connection, 'deleteKnowledgeEntry');
  const id = parseIdInput(body);
  const result = await connection.query(
    `DELETE FROM bot_knowledge_entries WHERE id = $1 AND tenant_id = app.current_tenant_id()`,
    [id],
  );
  if (result.rowCount === 0) throw entryNotFound();
}

// ---------------------------------------------------------------------------
// What the rest of the platform consumes
// ---------------------------------------------------------------------------

/** Whether the tenant has configured any knowledge at all (AC10). */
export function knowledgeConfigured(configuration: KnowledgeConfiguration): boolean {
  return configuration.entries.length > 0;
}

/**
 * The business-knowledge section of the bot's instructions, or `undefined` when
 * the tenant has none — an empty knowledge area is the section being absent, so
 * the bot answers from general knowledge with nothing to contradict (the spec's
 * assumed boundary; see `fallback-response-behavior.md` for what it cannot answer).
 *
 * Every entry passed in is rendered, in order, each as a JSON string: an entry is
 * multi-line, and quoting keeps one entry's text from reading as the start of the
 * next, or as an instruction about the list itself. The framing tells the model
 * to treat the entries as facts it must not contradict (AC5, AC6) and, by
 * omission, that a removed entry is no longer a fact the business asserts (AC8).
 *
 * The reply path passes what `selectKnowledge` chose. A selection adds one
 * sentence: without it, a fact left out reads as a fact that is not so, and the
 * bot tells a customer the business does not do something it does.
 *
 * Pure and deterministic: the only input is what the tenant's own connection read.
 */
export function knowledgeDirectives(configuration: KnowledgeConfiguration): string | undefined {
  if (configuration.entries.length === 0) return undefined;
  return [
    'The business provided the following facts about itself, in its own words. Treat them as true and current. ' +
      'When a customer asks about something they cover, answer from them, and never state anything that contradicts them. ' +
      'Each fact is a quoted string:',
    ...configuration.entries.map((entry) => `- ${JSON.stringify(entry.content)}`),
    ...(configuration.partial === true ? [PARTIAL_KNOWLEDGE_NOTE] : []),
  ].join('\n');
}

const PARTIAL_KNOWLEDGE_NOTE =
  'These are only the facts most relevant to this conversation, not everything the business has told you. ' +
  'If the customer asks about something specific to this business that they do not cover, do not guess and ' +
  'do not say the business lacks it: take the "fallback" action with low_confidence.';

/** One entry as the client's configuration screen shows it. */
export function describeKnowledgeEntry(entry: KnowledgeEntry): {
  readonly id: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
} {
  return {
    id: entry.id,
    content: entry.content,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

/** What the client is told about knowledge on the status screen (AC10). */
export const KNOWLEDGE_RECOMMENDATION =
  'Add facts about your business — offerings, hours, policies, FAQs — so your bot can answer accurately. ' +
  'Recommended, but not required to go live.';

/**
 * Whether knowledge is configured, as the bot status screen shows it (AC10):
 * always `required: false`, and a recommendation while nothing is configured.
 */
export function describeKnowledgeStatus(configuration: KnowledgeConfiguration): {
  readonly configured: boolean;
  readonly required: false;
  readonly recommendation: string | null;
} {
  const configured = knowledgeConfigured(configuration);
  return { configured, required: false, recommendation: configured ? null : KNOWLEDGE_RECOMMENDATION };
}

/**
 * The whole knowledge area as the client's screen shows it (AC1, AC12): every
 * entry, whether anything is configured, and the limits the form needs, so the
 * form has no reason to hard-code them.
 */
export function describeKnowledge(configuration: KnowledgeConfiguration): {
  readonly entries: ReturnType<typeof describeKnowledgeEntry>[];
  readonly configured: boolean;
  readonly limits: typeof KNOWLEDGE_LIMITS;
} {
  return {
    entries: configuration.entries.map(describeKnowledgeEntry),
    configured: knowledgeConfigured(configuration),
    limits: KNOWLEDGE_LIMITS,
  };
}
