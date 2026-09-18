/**
 * The bot's persona and tone — `persona-and-tone-configuration.md`.
 *
 * Every rule about what a valid persona is lives here and nowhere else: the
 * required name, the two length limits, the formality scale, and the trait list.
 * `services/api` passes a request body straight to `savePersona`, which is the
 * only way to write one, so there is no path on which a persona reaches the
 * database without having been validated here.
 *
 * ## How "scoped to that client only" is enforced
 *
 * No function takes a tenant id. Each takes a `Connection` that the caller has
 * already bound to a tenant — in practice through
 * `IdentityService.withClientAction`, which derives the tenant from the session —
 * and the SQL writes `app.current_tenant_id()` rather than a parameter. Row-level
 * security on `bot_personas` then makes the other tenants' rows invisible, so
 * AC8 holds below the application rather than depending on a `WHERE` clause.
 *
 * ## How "the next response reflects the change" is enforced
 *
 * Nothing caches a persona. The reply path reads it inside the same tenant
 * transaction that assembles the reply, so a save committed before that
 * transaction starts is what the reply uses (AC5, AC11). Adding a cache here is
 * how those criteria quietly stop holding; if one is ever needed, it needs an
 * invalidation story first.
 *
 * ## Why formality and traits are optional
 *
 * The spec requires "at minimum" the bot's name and leaves the rest open
 * (IMPLEMENTATION_PLAN.md records the decision). Requiring a formality choice
 * would block a client from going live over a question with a perfectly good
 * neutral answer, and making it required later is a change to one validation
 * rule. What the platform does *not* do is invent a value: an unset formality is
 * stored as NULL and the prompt says nothing about it, so the client's view and
 * the bot's behaviour never disagree about what was chosen.
 */

import type { Connection } from '@zeddev/db';
import { ValidationError, type ConfigIssue } from '@zeddev/errors';
import { characters, CONTROL, parseMultilineText, requireTenant } from './shared.ts';

/** The formal-to-casual scale. Mirrored by a CHECK constraint in migration 0005. */
export const FORMALITY_LEVELS = ['formal', 'neutral', 'casual'] as const;
export type Formality = (typeof FORMALITY_LEVELS)[number];

/** Selectable personality traits. Mirrored by a CHECK constraint in migration 0005. */
export const STYLE_TRAITS = [
  'friendly',
  'professional',
  'playful',
  'empathetic',
  'enthusiastic',
  'calm',
  'concise',
  'witty',
] as const;
export type StyleTrait = (typeof STYLE_TRAITS)[number];

/**
 * Maximum lengths, in characters (Unicode code points).
 *
 * Code points rather than JavaScript string length, because `length` counts
 * UTF-16 units and would reject a 30-emoji name that PostgreSQL — which counts
 * characters — accepts, or the reverse. The migration's CHECK constraints use the
 * same numbers, and a test asserts the two agree at the boundary.
 *
 * Fifty characters for the name: it is how the bot introduces itself in a chat
 * message, and anything longer is a sentence, not a name. Two thousand for the
 * freeform text: enough for several paragraphs of tone guidance, and small
 * enough that it cannot crowd business knowledge and conversation memory out of
 * the model's context on a free-tier provider.
 */
export const PERSONA_LIMITS = {
  botNameMaxLength: 50,
  freeformInstructionsMaxLength: 2000,
} as const;

/** The request fields `savePersona` accepts. Anything else is refused by name. */
export const PERSONA_FIELDS = ['botName', 'formality', 'styleTraits', 'freeformInstructions'] as const;

/** A saved, and therefore complete, persona. */
export interface Persona {
  readonly botName: string;
  readonly formality: Formality | null;
  readonly styleTraits: readonly StyleTrait[];
  readonly freeformInstructions: string | null;
  readonly updatedAt: Date;
}

/** A validated persona, not yet saved. */
export interface PersonaInput {
  readonly botName: string;
  readonly formality: Formality | null;
  readonly styleTraits: readonly StyleTrait[];
  readonly freeformInstructions: string | null;
}

/** The persona/tone contribution to `bot-activation-control.md`'s readiness gate. */
export interface PersonaReadiness {
  readonly condition: 'persona';
  readonly met: boolean;
  /** The required fields that are not yet filled in. Empty when `met`. */
  readonly missing: readonly string[];
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate and normalise a persona submission, reporting every problem at once.
 *
 * A save replaces the whole persona, so an absent optional field means "not
 * set", not "leave as it was" — a form that submits what it shows cannot then
 * resurrect a value the client just removed.
 *
 * The reasons name limits and accepted values but never echo what was submitted:
 * `ValidationError`'s issues reach the HTTP response and the logs, and the
 * freeform text is client content.
 */
export function parsePersonaInput(body: Readonly<Record<string, unknown>>): PersonaInput {
  const issues: ConfigIssue[] = [];
  const known = new Set<string>(PERSONA_FIELDS);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) issues.push({ key, reason: 'is not a recognised field' });
  }

  // botName — required (AC3), one line, bounded (AC10).
  let botName = '';
  const rawName = body.botName;
  if (rawName === undefined || rawName === null) {
    issues.push({ key: 'botName', reason: 'is required' });
  } else if (typeof rawName !== 'string') {
    issues.push({ key: 'botName', reason: 'must be a string' });
  } else {
    botName = rawName.normalize('NFC').trim();
    if (botName === '') {
      issues.push({ key: 'botName', reason: 'is required' });
    } else if (CONTROL.test(botName)) {
      issues.push({ key: 'botName', reason: 'must be a single line of text' });
    } else if (characters(botName) > PERSONA_LIMITS.botNameMaxLength) {
      issues.push({ key: 'botName', reason: `must be at most ${PERSONA_LIMITS.botNameMaxLength} characters` });
    }
  }

  // formality — optional, one of the scale.
  let formality: Formality | null = null;
  const rawFormality = body.formality;
  if (rawFormality !== undefined && rawFormality !== null) {
    if (typeof rawFormality === 'string' && (FORMALITY_LEVELS as readonly string[]).includes(rawFormality)) {
      formality = rawFormality as Formality;
    } else {
      issues.push({ key: 'formality', reason: `must be one of: ${FORMALITY_LEVELS.join(', ')}` });
    }
  }

  // styleTraits — optional, a subset of the list. Stored deduplicated and in the
  // list's own order, so two submissions choosing the same traits are the same
  // persona and render the same prompt.
  let styleTraits: StyleTrait[] = [];
  const rawTraits = body.styleTraits;
  if (rawTraits !== undefined && rawTraits !== null) {
    if (!Array.isArray(rawTraits)) {
      issues.push({ key: 'styleTraits', reason: 'must be a list' });
    } else if (!rawTraits.every((trait) => typeof trait === 'string' && (STYLE_TRAITS as readonly string[]).includes(trait))) {
      issues.push({ key: 'styleTraits', reason: `may only contain: ${STYLE_TRAITS.join(', ')}` });
    } else {
      const chosen = new Set<string>(rawTraits as string[]);
      styleTraits = STYLE_TRAITS.filter((trait) => chosen.has(trait));
    }
  }

  // freeformInstructions — optional (the spec forbids requiring it), bounded (AC9).
  // Blank is the same as absent: there is one representation of "cleared".
  const freeformInstructions = parseMultilineText(
    body.freeformInstructions,
    'freeformInstructions',
    PERSONA_LIMITS.freeformInstructionsMaxLength,
    issues,
  );

  if (issues.length > 0) throw new ValidationError(issues);
  return { botName, formality, styleTraits, freeformInstructions };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface PersonaRow {
  bot_name: string;
  formality: Formality | null;
  style_traits: StyleTrait[];
  freeform_instructions: string | null;
  updated_at: Date;
}

const COLUMNS = 'bot_name, formality, style_traits, freeform_instructions, updated_at';

function fromRow(row: PersonaRow): Persona {
  return {
    botName: row.bot_name,
    formality: row.formality,
    styleTraits: row.style_traits,
    freeformInstructions: row.freeform_instructions,
    updatedAt: row.updated_at,
  };
}


/** The tenant's persona, or `undefined` if it has never saved one (AC1). */
export async function readPersona(connection: Connection): Promise<Persona | undefined> {
  requireTenant(connection, 'readPersona');
  const result = await connection.query<PersonaRow>(
    `SELECT ${COLUMNS} FROM bot_personas WHERE tenant_id = app.current_tenant_id()`,
  );
  const row = result.rows[0];
  return row === undefined ? undefined : fromRow(row);
}

/**
 * Validate and save the tenant's persona, replacing whatever was there.
 *
 * Takes the raw submission rather than a `PersonaInput` so that validation is not
 * a step a caller can skip.
 */
export async function savePersona(
  connection: Connection,
  body: Readonly<Record<string, unknown>>,
): Promise<Persona> {
  requireTenant(connection, 'savePersona');
  const input = parsePersonaInput(body);
  const result = await connection.query<PersonaRow>(
    `INSERT INTO bot_personas (tenant_id, bot_name, formality, style_traits, freeform_instructions)
     VALUES (app.current_tenant_id(), $1, $2, $3::text[], $4)
     ON CONFLICT (tenant_id) DO UPDATE
       SET bot_name              = EXCLUDED.bot_name,
           formality             = EXCLUDED.formality,
           style_traits          = EXCLUDED.style_traits,
           freeform_instructions = EXCLUDED.freeform_instructions,
           updated_at            = now()
     RETURNING ${COLUMNS}`,
    [input.botName, input.formality, input.styleTraits, input.freeformInstructions],
  );
  return fromRow(result.rows[0]!);
}

/**
 * Clear the freeform text and nothing else.
 *
 * A separate operation, not only "save with the field blank", because the spec
 * asks for clearing "independently of the structured fields": a client should not
 * have to resubmit their bot's name to delete a paragraph. Clearing a persona that
 * was never saved is not an error — the text is already absent.
 */
export async function clearFreeformInstructions(connection: Connection): Promise<Persona | undefined> {
  requireTenant(connection, 'clearFreeformInstructions');
  const result = await connection.query<PersonaRow>(
    `UPDATE bot_personas
        SET freeform_instructions = NULL,
            updated_at            = now()
      WHERE tenant_id = app.current_tenant_id()
      RETURNING ${COLUMNS}`,
  );
  const row = result.rows[0];
  return row === undefined ? undefined : fromRow(row);
}

// ---------------------------------------------------------------------------
// What the rest of the platform consumes
// ---------------------------------------------------------------------------

/**
 * Whether persona/tone satisfies its part of the readiness gate (AC7).
 *
 * A saved persona is complete by construction — the save refuses one without a
 * name and the column is NOT NULL — so this is whether one exists. Reported as a
 * list of missing fields rather than a boolean because `bot-activation-control.md`
 * requires telling a not-ready client *which* condition is unmet.
 */
export function personaReadiness(persona: Persona | undefined): PersonaReadiness {
  return persona === undefined
    ? { condition: 'persona', met: false, missing: ['botName'] }
    : { condition: 'persona', met: true, missing: [] };
}

const FORMALITY_DIRECTIVES: Readonly<Record<Formality, string>> = {
  formal: 'Use a formal register: courteous, complete sentences, no slang or emoji.',
  neutral: 'Use a neutral, polite register — neither stiff nor overly casual.',
  casual: 'Use a casual, relaxed register, as in a friendly chat. Light slang is fine.',
};

/**
 * The persona section of the bot's instructions.
 *
 * Both mechanisms appear whenever both are set — the spec forbids "silently
 * discarding one" — with the structured fields first and the client's own words
 * after, labelled as theirs. Precedence between them is deliberately not stated:
 * the spec leaves the combination open, and a client who writes freeform text
 * contradicting their formality setting is better served by the model seeing both
 * than by the platform guessing which they meant.
 *
 * Pure and deterministic, so the same persona always yields the same text: the
 * whole of AC8 at this layer is that the only input is the persona the tenant's
 * own connection read.
 */
export function personaDirectives(persona: Persona): string {
  const lines = [
    `You are ${JSON.stringify(persona.botName)}, the assistant for this business. ` +
      'When you introduce yourself or are asked your name, use exactly this name.',
  ];
  if (persona.formality !== null) lines.push(FORMALITY_DIRECTIVES[persona.formality]);
  if (persona.styleTraits.length > 0) {
    lines.push(`Your communication style is: ${persona.styleTraits.join(', ')}.`);
  }
  if (persona.freeformInstructions !== null) {
    lines.push('The business gave these additional persona and tone instructions:', persona.freeformInstructions);
  }
  return lines.join('\n');
}

/**
 * The persona as the client's configuration screen shows it.
 *
 * Carries the limits and the selectable options alongside the values, because
 * the spec requires the limits be *communicated* — not only enforced on save —
 * and AC1 requires the structured fields be presented even before anything is
 * saved. A never-configured tenant gets every field empty.
 */
export function describePersona(persona: Persona | undefined): {
  readonly persona: {
    readonly botName: string | null;
    readonly formality: Formality | null;
    readonly styleTraits: readonly StyleTrait[];
    readonly freeformInstructions: string | null;
    readonly updatedAt: string | null;
  };
  readonly complete: boolean;
  readonly missing: readonly string[];
  readonly limits: typeof PERSONA_LIMITS;
  readonly options: { readonly formality: typeof FORMALITY_LEVELS; readonly styleTraits: typeof STYLE_TRAITS };
} {
  const readiness = personaReadiness(persona);
  return {
    persona: {
      botName: persona?.botName ?? null,
      formality: persona?.formality ?? null,
      styleTraits: persona?.styleTraits ?? [],
      freeformInstructions: persona?.freeformInstructions ?? null,
      updatedAt: persona?.updatedAt.toISOString() ?? null,
    },
    complete: readiness.met,
    missing: readiness.missing,
    limits: PERSONA_LIMITS,
    options: { formality: FORMALITY_LEVELS, styleTraits: STYLE_TRAITS },
  };
}
