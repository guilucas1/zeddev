/**
 * Text-format codec: PostgreSQL values to and from JavaScript.
 *
 * Every value crosses the wire as text (see `wire.ts` `bindMessage` for why), so
 * this module is the whole of the type system the platform sees. Three decisions
 * in it are load-bearing and were made deliberately rather than by default:
 *
 *   1. **`numeric` decodes to a string, never a number.** `cost-efficient-
 *      operation.md` requires per-tenant cost and usage figures be reported
 *      accurately; a currency amount that has been through an IEEE-754 double is
 *      not accurate, and the corruption is invisible until it is a billing
 *      dispute. Callers that want arithmetic must opt into it explicitly.
 *   2. **`int8` decodes to a number only when it is exactly representable.**
 *      Silently rounding a bigint is the same failure as (1) with a wider
 *      threshold, so anything beyond `Number.MAX_SAFE_INTEGER` becomes a bigint.
 *      In practice every `count(*)` this platform runs stays a number.
 *   3. **A `Secret` passed as a query parameter is refused.** Storing a
 *      credential requires calling `.expose()` first, which keeps
 *      `credential-and-secret-handling.md`'s "which components can see this
 *      secret" question answerable by grep. The one legitimate path — storing a
 *      sealed credential — passes the *sealed string*, which is not a `Secret`.
 */

import { ValidationError } from '@zeddev/errors';
import { isSecret } from '@zeddev/secrets';

/** Type OIDs from `pg_type`. Stable across every PostgreSQL version. */
export const OID = {
  bool: 16,
  bytea: 17,
  char: 18,
  name: 19,
  int8: 20,
  int2: 21,
  int4: 23,
  text: 25,
  oid: 26,
  json: 114,
  xml: 142,
  float4: 700,
  float8: 701,
  inet: 869,
  bpchar: 1042,
  varchar: 1043,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  timetz: 1266,
  numeric: 1700,
  uuid: 2950,
  jsonb: 3802,
} as const;

/**
 * Array type OID to its element type OID.
 *
 * Enumerated rather than looked up from `pg_type` at connect time: a catalogue
 * round trip on every connection is a cost paid forever to learn constants that
 * have not changed in twenty years, and it would make connecting depend on the
 * connecting role having catalogue read permission.
 */
const ARRAY_ELEMENT: ReadonlyMap<number, number> = new Map([
  [1000, OID.bool],
  [1001, OID.bytea],
  [1002, OID.char],
  [1003, OID.name],
  [1005, OID.int2],
  [1007, OID.int4],
  [1009, OID.text],
  [1014, OID.bpchar],
  [1015, OID.varchar],
  [1016, OID.int8],
  [1021, OID.float4],
  [1022, OID.float8],
  [1028, OID.oid],
  [1115, OID.timestamp],
  [1182, OID.date],
  [1183, OID.time],
  [1185, OID.timestamptz],
  [1187, OID.interval],
  [1231, OID.numeric],
  [199, OID.json],
  [3807, OID.jsonb],
  [2951, OID.uuid],
]);

/**
 * Normalise PostgreSQL's ISO timestamp text into something `Date` accepts.
 *
 * Two shapes need fixing. PostgreSQL writes a space between the date and the
 * time, and it writes a two-digit UTC offset (`+00`) where ISO 8601 wants
 * `+00:00`. `new Date('2026-08-25 12:00:00+00')` is implementation-defined; the
 * normalised form is not.
 *
 * `assumeUtc` covers `timestamp without time zone`, which carries no offset at
 * all. The schema uses `timestamptz` everywhere precisely so this branch is not
 * relied upon — a bare `timestamp` means the stored instant depends on the
 * session's time zone, and a value whose meaning depends on who reads it cannot
 * satisfy `operator-health-monitoring.md`'s requirement for accurate transition
 * timestamps.
 */
export function normalizeTimestampText(raw: string, assumeUtc: boolean): string {
  let text = raw.replace(' ', 'T');
  const offset = /([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?$/.exec(text);
  if (offset !== null) {
    if (offset[3] === undefined) text = `${text}:00`;
  } else if (!text.endsWith('Z') && assumeUtc) {
    text = `${text}Z`;
  }
  return text;
}

/**
 * Parse PostgreSQL's array text form, e.g. `{1,2,NULL}` or `{{a,b},{c,d}}`.
 *
 * Returns nested arrays of raw element text, with `null` for the unquoted literal
 * `NULL`. The quoting distinction matters: `{NULL}` is a one-element array
 * containing SQL NULL, while `{"NULL"}` is a one-element array containing the
 * four-character string. Collapsing them would turn a customer's literal text
 * into a null.
 */
export function parseArrayText(raw: string): (string | null | unknown[])[] {
  let index = 0;

  function parseArray(): (string | null | unknown[])[] {
    const items: (string | null | unknown[])[] = [];
    index += 1; // consume '{'
    if (raw[index] === '}') {
      index += 1;
      return items;
    }
    for (;;) {
      const char = raw[index];
      if (char === '{') {
        items.push(parseArray());
      } else if (char === '"') {
        index += 1;
        let value = '';
        while (raw[index] !== '"') {
          if (raw[index] === '\\') index += 1;
          value += raw[index];
          index += 1;
        }
        index += 1; // consume closing quote
        items.push(value);
      } else {
        let value = '';
        while (index < raw.length && raw[index] !== ',' && raw[index] !== '}') {
          value += raw[index];
          index += 1;
        }
        items.push(value === 'NULL' ? null : value);
      }
      if (raw[index] === ',') {
        index += 1;
        continue;
      }
      index += 1; // consume '}'
      return items;
    }
  }

  if (raw[0] !== '{') throw new ValidationError([{ key: 'array', reason: 'malformed array literal' }]);
  return parseArray();
}

/** Decode one text-format column value according to its type OID. */
export function decodeValue(typeOid: number, raw: string): unknown {
  const elementOid = ARRAY_ELEMENT.get(typeOid);
  if (elementOid !== undefined) {
    const decodeNested = (node: unknown): unknown => {
      if (node === null) return null;
      if (Array.isArray(node)) return node.map(decodeNested);
      return decodeValue(elementOid, node as string);
    };
    return parseArrayText(raw).map(decodeNested);
  }

  switch (typeOid) {
    case OID.bool:
      return raw === 't';
    case OID.int2:
    case OID.int4:
    case OID.oid:
      return Number(raw);
    case OID.int8: {
      const asNumber = Number(raw);
      return Number.isSafeInteger(asNumber) ? asNumber : BigInt(raw);
    }
    case OID.float4:
    case OID.float8:
      return Number(raw);
    case OID.bytea:
      return raw.startsWith('\\x') ? Buffer.from(raw.slice(2), 'hex') : Buffer.from(raw, 'utf8');
    case OID.json:
    case OID.jsonb:
      return JSON.parse(raw);
    case OID.timestamptz:
      return new Date(normalizeTimestampText(raw, false));
    case OID.timestamp:
      return new Date(normalizeTimestampText(raw, true));
    // `date`, `time`, `interval` and `numeric` stay text. Each of them loses
    // information when forced into a JS `Date` or `number`: a date acquires a
    // spurious time zone, an interval acquires a spurious anchor date, and a
    // numeric acquires rounding.
    default:
      return raw;
  }
}

function arrayLiteral(values: readonly unknown[]): string {
  const parts = values.map((value) => {
    if (value === null || value === undefined) return 'NULL';
    if (Array.isArray(value)) return arrayLiteral(value);
    const text = scalarText(value);
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
  return `{${parts.join(',')}}`;
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 't' : 'f';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ValidationError([
        { key: 'parameter', reason: 'NaN and Infinity have no PostgreSQL representation' },
      ]);
    }
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString('hex')}`;
  return JSON.stringify(value);
}

/**
 * Encode one query parameter into its text form, or `null` for SQL NULL.
 *
 * `undefined` maps to NULL rather than throwing. That is a considered choice: an
 * optional column read out of a partially-populated object arrives as
 * `undefined`, and making every call site coalesce it produces `?? null` noise
 * that hides the cases where the absence was actually a bug.
 */
export function encodeParam(value: unknown): Buffer | null {
  if (value === null || value === undefined) return null;
  if (isSecret(value)) {
    throw new ValidationError([
      {
        key: 'parameter',
        reason:
          'a Secret cannot be sent to the database directly — seal it first, or call expose() at the call site so the disclosure is greppable',
      },
    ]);
  }
  if (Array.isArray(value)) return Buffer.from(arrayLiteral(value), 'utf8');
  return Buffer.from(scalarText(value), 'utf8');
}

/**
 * The row count a CommandComplete tag reports, or 0 when it reports none.
 *
 * Tags look like `INSERT 0 3`, `UPDATE 2`, `SELECT 7`, `CREATE TABLE`. The
 * trailing number is the affected row count except for INSERT, where it is the
 * second of two fields — the first being a legacy OID that is always 0.
 */
export function rowCountFromTag(tag: string): number {
  const parts = tag.split(' ');
  const last = parts[parts.length - 1];
  if (last === undefined) return 0;
  const count = Number(last);
  return Number.isInteger(count) ? count : 0;
}
