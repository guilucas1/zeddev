/**
 * Configuration: a declarative environment-variable schema, parsed once at startup.
 *
 * `environment-portability.md` is the demanding spec here, and it asks for four
 * things that shape this design:
 *
 *   - AC7: a missing or invalid value causes a *clear error identifying it*,
 *     rather than a partial or broken start.
 *   - AC5: no branching on which environment tier the system is running on.
 *   - AC6: the documented list of configuration inputs is by itself sufficient to
 *     explain every behavioral difference between two deployments.
 *   - The system must not require "manual, undocumented, or tribal-knowledge
 *     steps" beyond supplying the documented inputs.
 *
 * AC6 is the one that dictates the shape. If the schema is the single source of
 * truth *and* the documentation is generated from it, then the two cannot drift.
 * A hand-maintained `.env.example` alongside a hand-written parser is exactly how
 * a config input ends up undocumented, and undocumented config is what turns
 * moving between tiers into tribal knowledge. So `renderReference()` generates
 * the documentation from the same declaration the parser uses.
 *
 * Everything is collected before anything is thrown. Reporting the first missing
 * key only, then the next on restart, is a guess-and-restart loop — technically
 * "a clear error", practically the opposite of diagnosable.
 */

import { ConfigurationError, type ConfigIssue } from '@zeddev/errors';
import { Secret } from '@zeddev/secrets';

/** The raw environment. Injected rather than read from `process.env` so it is testable. */
export type RawEnv = Readonly<Record<string, string | undefined>>;

export type ConfigValueType = 'string' | 'number' | 'integer' | 'boolean' | 'duration' | 'enum' | 'url';

interface BaseSpec<T> {
  /** Why this exists and what it controls. Becomes the generated documentation. */
  readonly description: string;
  /**
   * Used when the variable is absent.
   *
   * A key with a default is optional; a key without one is required. There is no
   * third state, because "optional with no default" means some code downstream
   * invents a fallback, and an invented fallback is a behavioral difference that
   * the documented input list cannot explain — a direct AC6 violation.
   */
  readonly default?: T;
  /**
   * Marks the value as a secret.
   *
   * Secret values are wrapped in `Secret` so they cannot be logged, and the
   * generated reference shows a placeholder instead of any real value.
   * `credential-and-secret-handling.md` AC2 requires a missing secret produce the
   * same clear startup failure as any other missing config.
   */
  readonly secret?: boolean;
  /** Example for the generated reference. Must never be a real credential. */
  readonly example?: string;
}

export interface StringSpec extends BaseSpec<string> {
  readonly type: 'string';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
}

export interface NumberSpec extends BaseSpec<number> {
  readonly type: 'number' | 'integer';
  readonly min?: number;
  readonly max?: number;
}

export interface BooleanSpec extends BaseSpec<boolean> {
  readonly type: 'boolean';
}

/**
 * A duration, parsed from a unit-suffixed string into milliseconds.
 *
 * Units are mandatory. `MEMORY_RESET_WINDOW=3600` is ambiguous between seconds
 * and milliseconds, and getting it wrong silently changes when a customer's
 * conversation memory resets by a factor of a thousand. `1h` cannot be misread.
 */
export interface DurationSpec extends BaseSpec<number> {
  readonly type: 'duration';
  readonly min?: number;
  readonly max?: number;
}

export interface EnumSpec<V extends string = string> extends BaseSpec<V> {
  readonly type: 'enum';
  readonly values: readonly V[];
}

export interface UrlSpec extends BaseSpec<string> {
  readonly type: 'url';
  readonly protocols?: readonly string[];
}

export type ConfigSpec = StringSpec | NumberSpec | BooleanSpec | DurationSpec | EnumSpec | UrlSpec;

export type ConfigSchema = Readonly<Record<string, ConfigSpec>>;

/** The parsed type of one spec. Secret specs resolve to `Secret<string>`. */
type ValueOf<S extends ConfigSpec> = S extends { secret: true }
  ? Secret<string>
  : S extends EnumSpec<infer V>
    ? V
    : S extends { type: 'string' | 'url' }
      ? string
      : S extends { type: 'number' | 'integer' | 'duration' }
        ? number
        : S extends { type: 'boolean' }
          ? boolean
          : never;

export type Config<S extends ConfigSchema> = { readonly [K in keyof S]: ValueOf<S[K]> };

const DURATION_UNITS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a unit-suffixed duration, e.g. `500ms`, `30s`, `24h`, `7d`. */
export function parseDuration(raw: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(raw.trim());
  if (match === null) return undefined;
  const unit = DURATION_UNITS[match[2]!];
  return unit === undefined ? undefined : Number(match[1]) * unit;
}

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

function parseOne(key: string, spec: ConfigSpec, raw: string, issues: ConfigIssue[]): unknown {
  switch (spec.type) {
    case 'string': {
      if (spec.minLength !== undefined && raw.length < spec.minLength) {
        issues.push({ key, reason: `must be at least ${spec.minLength} characters` });
        return undefined;
      }
      if (spec.maxLength !== undefined && raw.length > spec.maxLength) {
        issues.push({ key, reason: `must be at most ${spec.maxLength} characters` });
        return undefined;
      }
      if (spec.pattern !== undefined && !spec.pattern.test(raw)) {
        issues.push({ key, reason: `must match ${String(spec.pattern)}` });
        return undefined;
      }
      return raw;
    }
    case 'number':
    case 'integer': {
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        issues.push({ key, reason: `must be a number, got ${JSON.stringify(raw)}` });
        return undefined;
      }
      if (spec.type === 'integer' && !Number.isInteger(n)) {
        issues.push({ key, reason: `must be an integer, got ${JSON.stringify(raw)}` });
        return undefined;
      }
      if (spec.min !== undefined && n < spec.min) {
        issues.push({ key, reason: `must be >= ${spec.min}` });
        return undefined;
      }
      if (spec.max !== undefined && n > spec.max) {
        issues.push({ key, reason: `must be <= ${spec.max}` });
        return undefined;
      }
      return n;
    }
    case 'boolean': {
      const lowered = raw.trim().toLowerCase();
      if (TRUE_VALUES.has(lowered)) return true;
      if (FALSE_VALUES.has(lowered)) return false;
      issues.push({
        key,
        reason: `must be one of true/false/1/0/yes/no/on/off, got ${JSON.stringify(raw)}`,
      });
      return undefined;
    }
    case 'duration': {
      const ms = parseDuration(raw);
      if (ms === undefined) {
        issues.push({
          key,
          reason: `must be a duration with an explicit unit (ms, s, m, h, d), e.g. "30s", got ${JSON.stringify(raw)}`,
        });
        return undefined;
      }
      if (spec.min !== undefined && ms < spec.min) {
        issues.push({ key, reason: `must be >= ${spec.min}ms` });
        return undefined;
      }
      if (spec.max !== undefined && ms > spec.max) {
        issues.push({ key, reason: `must be <= ${spec.max}ms` });
        return undefined;
      }
      return ms;
    }
    case 'enum': {
      if (!spec.values.includes(raw)) {
        issues.push({ key, reason: `must be one of: ${spec.values.join(', ')}` });
        return undefined;
      }
      return raw;
    }
    case 'url': {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        issues.push({ key, reason: 'must be a valid absolute URL' });
        return undefined;
      }
      const allowed = spec.protocols;
      if (allowed !== undefined && !allowed.includes(url.protocol.replace(':', ''))) {
        issues.push({ key, reason: `URL scheme must be one of: ${allowed.join(', ')}` });
        return undefined;
      }
      return raw;
    }
  }
}

/**
 * Parse and validate the environment against a schema.
 *
 * Throws `ConfigurationError` listing *every* problem, never just the first.
 *
 * An empty string is treated as absent. Container orchestrators and Compose files
 * routinely materialise an unset variable as `""`, and treating that as a
 * supplied-but-empty value produces a confusing downstream failure far from the
 * cause — precisely the "silently falling back to incorrect behavior" that AC7
 * forbids.
 */
export function loadConfig<S extends ConfigSchema>(schema: S, env: RawEnv = process.env): Config<S> {
  const issues: ConfigIssue[] = [];
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(schema).sort()) {
    const spec = schema[key]!;
    const raw = env[key];
    const absent = raw === undefined || raw.trim() === '';

    if (absent) {
      if (spec.default === undefined) {
        issues.push({
          key,
          reason: `required but not set — ${spec.description}`,
        });
        continue;
      }
      out[key] = spec.secret === true ? new Secret(String(spec.default), key) : spec.default;
      continue;
    }

    const parsed = parseOne(key, spec, raw, issues);
    if (parsed === undefined) continue;
    out[key] = spec.secret === true ? new Secret(String(parsed), key) : parsed;
  }

  if (issues.length > 0) throw new ConfigurationError(issues);
  return Object.freeze(out) as Config<S>;
}

/**
 * Run each loader, collecting every configuration issue across all of them.
 *
 * A service reads several packages' schemas at startup. Stopping at the first one
 * that fails would turn configuring a new tier into a fix-one-restart-repeat loop,
 * which `environment-portability.md` AC7 rules out as firmly as `loadConfig`
 * rules it out within one schema. A loader that throws anything other than
 * `ConfigurationError` is a defect, not a misconfiguration, and is rethrown
 * immediately.
 */
export function loadAll<T extends readonly (() => unknown)[]>(
  loaders: T,
): { [K in keyof T]: T[K] extends () => infer R ? R : never } {
  const issues: ConfigIssue[] = [];
  const results = loaders.map((load) => {
    try {
      return load();
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      issues.push(...error.issues);
      return undefined;
    }
  });
  if (issues.length > 0) throw new ConfigurationError(issues);
  return results as { [K in keyof T]: T[K] extends () => infer R ? R : never };
}

/**
 * Generate the environment-variable reference documentation from a schema.
 *
 * This is what makes `environment-portability.md` AC6 hold: the documented list
 * of inputs is derived from the same declaration the parser enforces, so it
 * cannot be incomplete or stale. Hand-written config docs are always eventually
 * both.
 */
export function renderReference(schema: ConfigSchema, options?: { title?: string }): string {
  const lines: string[] = [];
  lines.push(`# ${options?.title ?? 'Configuration reference'}`);
  lines.push('');
  lines.push(
    'Generated from the configuration schema. Do not edit by hand — change the schema instead.',
  );
  lines.push('');
  lines.push('| Variable | Type | Required | Default | Description |');
  lines.push('| --- | --- | --- | --- | --- |');

  for (const key of Object.keys(schema).sort()) {
    const spec = schema[key]!;
    const required = spec.default === undefined ? 'yes' : 'no';
    const defaultCell =
      spec.default === undefined ? '—' : spec.secret === true ? '`<secret>`' : `\`${String(spec.default)}\``;
    const type = spec.type === 'enum' ? `enum(${(spec as EnumSpec).values.join('\\|')})` : spec.type;
    const description = spec.secret === true ? `${spec.description} **(secret)**` : spec.description;
    lines.push(`| \`${key}\` | ${type} | ${required} | ${defaultCell} | ${description} |`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Generate a `.env` template from a schema.
 *
 * Required keys are left blank so that starting from the template and forgetting
 * one produces the AC7 startup failure, rather than a plausible-looking default
 * that silently changes behavior.
 */
export function renderEnvTemplate(schema: ConfigSchema): string {
  const lines: string[] = [];
  for (const key of Object.keys(schema).sort()) {
    const spec = schema[key]!;
    lines.push(`# ${spec.description}`);
    if (spec.type === 'enum') lines.push(`# one of: ${(spec as EnumSpec).values.join(', ')}`);
    if (spec.default !== undefined && spec.secret !== true) {
      lines.push(`# default: ${String(spec.default)}`);
    }
    const value =
      spec.secret === true
        ? (spec.example ?? '')
        : spec.default !== undefined
          ? String(spec.default)
          : (spec.example ?? '');
    lines.push(`${key}=${value}`);
    lines.push('');
  }
  return lines.join('\n');
}
