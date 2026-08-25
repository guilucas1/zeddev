/**
 * Secret handling: wrapping, one-way credential storage, and reversible sealing.
 *
 * `credential-and-secret-handling.md` draws a hard line between two kinds of
 * secret, and the whole design of this module follows it:
 *
 *   - Credentials the platform only ever *checks* — client and operator account
 *     passwords — must be stored one-way, so that possession of the stored form
 *     alone does not allow authentication as that principal (AC3). `hashCredential`
 *     covers these.
 *   - Credentials the platform must *use* — per-tenant WhatsApp tokens, the AI
 *     provider key, infrastructure credentials, the webhook signing secret — cannot
 *     be irreversibly transformed, so they are encrypted at rest such that reading
 *     the stored data alone is insufficient to use them (AC4). `SecretSealer`
 *     covers these.
 *
 * Conflating the two is the classic mistake in both directions: reversibly
 * encrypting a password gives an attacker with the key every account, and hashing
 * an API token makes it useless.
 *
 * The `Secret` wrapper addresses a different requirement — AC5, that no secret
 * value appear in any log, diagnostic, error message, metric, alert, or
 * notification. Redaction is enforced at the value, not at each call site,
 * because a call site that must remember to redact will eventually forget.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { ConfigurationError, ValidationError } from '@zeddev/errors';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * The classes of secret the platform recognises, per
 * `credential-and-secret-handling.md`'s enumerated list plus the webhook signing
 * secret that `message-delivery-reliability.md` AC2 requires for authenticity
 * verification.
 *
 * Enumerated because AC14 requires an access record identifying *what secret
 * class* was touched, without the value. A free-form string there would drift
 * into holding the secret's identity or, eventually, the secret.
 */
export const SECRET_CLASSES = [
  'tenant_whatsapp_credential',
  'client_account_credential',
  'operator_account_credential',
  'ai_provider_credential',
  'infrastructure_credential',
  'webhook_signing_secret',
] as const;

export type SecretClass = (typeof SECRET_CLASSES)[number];

const REDACTED = '[redacted]';

/**
 * A value that must never be serialized.
 *
 * Every path by which a value normally escapes into a log line is closed:
 * `toString` for template interpolation, `toJSON` for `JSON.stringify`,
 * `util.inspect.custom` for `console.log` and Node's error formatting, and
 * `Symbol.toPrimitive` for implicit coercion. Reading the value requires calling
 * `expose()`, which is greppable — so "who can see this secret" is answerable by
 * searching the codebase rather than by reasoning about every log statement.
 */
export class Secret<T extends string | Buffer = string> {
  readonly #value: T;
  readonly #label: string;

  constructor(value: T, label: string) {
    this.#value = value;
    this.#label = label;
  }

  /** Deliberately explicit and greppable. This is the only way out. */
  expose(): T {
    return this.#value;
  }

  /** A non-sensitive name for this secret, safe to log. */
  get label(): string {
    return this.#label;
  }

  /**
   * A stable, non-reversible reference to this secret's *value*.
   *
   * AC5 permits identifying a secret in support contexts by "a non-sensitive
   * reference or a redacted form". A truncated SHA-256 gives operators something
   * they can compare across two records ("is the token the tenant configured the
   * same one that is failing?") without revealing anything about the value.
   */
  get ref(): string {
    return secretRef(this.#value);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  get [Symbol.toStringTag](): string {
    return 'Secret';
  }

  /** Node's `util.inspect` hook — covers `console.log` and uncaught-error rendering. */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `Secret(${this.#label}) ${REDACTED}`;
  }
}

/** Truncated digest of a secret value, safe to log. Stable for a given value. */
export function secretRef(value: string | Buffer): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

/** Type guard, so generic serialization code can detect and refuse secrets. */
export function isSecret(value: unknown): value is Secret<string | Buffer> {
  return value instanceof Secret;
}

// ---------------------------------------------------------------------------
// One-way credential storage (client and operator account passwords)
// ---------------------------------------------------------------------------

/**
 * scrypt cost parameters.
 *
 * N=2^15 with r=8 needs roughly 32 MiB per hash, which is the point: it is what
 * makes offline brute-forcing of a stolen credential table expensive. `maxmem` is
 * raised above Node's 32 MiB default because the default sits exactly at the
 * boundary and would reject these parameters.
 */
const SCRYPT_DEFAULTS = { N: 32768, r: 8, p: 1, keylen: 32, maxmem: 96 * 1024 * 1024 } as const;

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/**
 * Hash a credential for storage, irreversibly.
 *
 * The returned string is self-describing: it carries the algorithm and the cost
 * parameters that produced it. That is what allows the cost to be raised later
 * without a migration — `verifyCredential` reads the parameters out of the stored
 * value rather than assuming today's constants, so old and new hashes verify side
 * by side under one code path.
 *
 * Format: `scrypt$N$r$p$<salt base64>$<hash base64>`
 */
export async function hashCredential(
  plaintext: string,
  params: ScryptParams = SCRYPT_DEFAULTS,
): Promise<string> {
  if (plaintext === '') throw new ValidationError([{ key: 'credential', reason: 'must not be empty' }]);
  const salt = randomBytes(16);
  const derived = await scrypt(plaintext, salt, SCRYPT_DEFAULTS.keylen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_DEFAULTS.maxmem,
  });
  return `scrypt$${params.N}$${params.r}$${params.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/**
 * Verify a credential against its stored one-way form.
 *
 * Returns `false` rather than throwing for a malformed stored value. A stored
 * hash that cannot be parsed must not become a way to authenticate, and it must
 * not become a way to distinguish "this account exists but its hash is corrupt"
 * from "wrong password" — `authentication-and-access.md` AC3 requires those be
 * indistinguishable to the caller.
 */
export async function verifyCredential(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const saltB64 = parts[4];
  const hashB64 = parts[5];
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  if (saltB64 === undefined || hashB64 === undefined) return false;

  const expected = Buffer.from(hashB64, 'base64');
  if (expected.length === 0) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(plaintext, Buffer.from(saltB64, 'base64'), expected.length, {
      N,
      r,
      p,
      maxmem: SCRYPT_DEFAULTS.maxmem,
    });
  } catch {
    return false;
  }
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

// ---------------------------------------------------------------------------
// Reversible sealing (WhatsApp tokens, AI provider keys, webhook secrets)
// ---------------------------------------------------------------------------

const SEAL_VERSION = 'v1';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length

/** A named encryption key. The name is what makes rotation possible. */
export interface SealingKey {
  readonly id: string;
  readonly key: Buffer;
}

/**
 * Parse a sealing key from configuration.
 *
 * Format: `<keyId>:<base64 32-byte key>`. The key id travels with the key so that
 * ciphertext can name the key that produced it, which is what lets a new key be
 * introduced while values sealed under the old one remain readable.
 */
export function parseSealingKey(raw: string, configKey: string): SealingKey {
  const separator = raw.indexOf(':');
  if (separator <= 0) {
    throw new ConfigurationError([
      { key: configKey, reason: 'expected format <keyId>:<base64-encoded 32-byte key>' },
    ]);
  }
  const id = raw.slice(0, separator);
  const key = Buffer.from(raw.slice(separator + 1), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new ConfigurationError([
      {
        key: configKey,
        reason: `key must decode to exactly ${KEY_BYTES} bytes, got ${key.length}`,
      },
    ]);
  }
  return { id, key };
}

/** Generate a fresh sealing key in the configuration format. */
export function generateSealingKey(id: string): string {
  return `${id}:${randomBytes(KEY_BYTES).toString('base64')}`;
}

/**
 * Seals and unseals secrets that the platform must be able to use.
 *
 * AES-256-GCM rather than a plain cipher because GCM authenticates the
 * ciphertext: a tampered stored value fails to unseal instead of decrypting to
 * attacker-chosen bytes that then get sent to Meta as a token.
 *
 * The key id is stored alongside every ciphertext, and the sealer holds a set of
 * keys with one designated active. Rotation is therefore: add the new key, make
 * it active, re-seal at leisure — never a flag day, and never a state where
 * previously sealed values are unreadable.
 */
export class SecretSealer {
  readonly #keys: ReadonlyMap<string, Buffer>;
  readonly #activeKeyId: string;

  constructor(keys: readonly SealingKey[], activeKeyId?: string) {
    if (keys.length === 0) {
      throw new ConfigurationError([
        { key: 'sealingKeys', reason: 'at least one sealing key is required' },
      ]);
    }
    this.#keys = new Map(keys.map((k) => [k.id, k.key]));
    const active = activeKeyId ?? keys[0]!.id;
    if (!this.#keys.has(active)) {
      throw new ConfigurationError([
        { key: 'activeKeyId', reason: `no sealing key with id "${active}" was supplied` },
      ]);
    }
    this.#activeKeyId = active;
  }

  get activeKeyId(): string {
    return this.#activeKeyId;
  }

  /**
   * Encrypt a secret for storage.
   *
   * Format: `v1$<keyId>$<iv base64>$<authTag base64>$<ciphertext base64>`
   */
  seal(plaintext: string | Buffer): string {
    const key = this.#keys.get(this.#activeKeyId)!;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return [
      SEAL_VERSION,
      this.#activeKeyId,
      iv.toString('base64'),
      tag.toString('base64'),
      ciphertext.toString('base64'),
    ].join('$');
  }

  /** Decrypt a sealed secret into a `Secret` wrapper, never a bare string. */
  unseal(sealed: string, label: string): Secret<string> {
    return new Secret(this.unsealToBuffer(sealed).toString('utf8'), label);
  }

  unsealToBuffer(sealed: string): Buffer {
    const parts = sealed.split('$');
    if (parts.length !== 5 || parts[0] !== SEAL_VERSION) {
      throw new ValidationError([{ key: 'sealed', reason: 'malformed sealed value' }]);
    }
    const [, keyId, ivB64, tagB64, ciphertextB64] = parts as [string, string, string, string, string];
    const key = this.#keys.get(keyId);
    if (key === undefined) {
      throw new ConfigurationError([
        { key: 'sealingKeys', reason: `sealed value references unknown key id "${keyId}"` },
      ]);
    }
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    try {
      return Buffer.concat([decipher.update(Buffer.from(ciphertextB64, 'base64')), decipher.final()]);
    } catch (cause) {
      // GCM authentication failure. Surfaced as a validation failure with no
      // detail: distinguishing "wrong key" from "tampered ciphertext" for a
      // caller is an oracle, and neither answer is actionable at this layer.
      throw new ValidationError([{ key: 'sealed', reason: 'authentication failed' }]);
    }
  }

  /** The key id a sealed value was produced under, without decrypting it. */
  static keyIdOf(sealed: string): string | undefined {
    const parts = sealed.split('$');
    return parts.length === 5 && parts[0] === SEAL_VERSION ? parts[1] : undefined;
  }
}

/**
 * A record that a secret was accessed or changed, per AC14.
 *
 * Note the absence of any field that could hold the value. The type makes the
 * guarantee, so satisfying AC14 does not depend on every writer of an audit
 * record remembering the rule.
 */
export interface SecretAccessRecord {
  readonly at: Date;
  readonly principal: string;
  readonly secretClass: SecretClass;
  readonly action: 'read' | 'created' | 'replaced' | 'deleted';
  /** Non-sensitive reference, e.g. the tenant the secret belongs to. */
  readonly subjectRef: string;
}
