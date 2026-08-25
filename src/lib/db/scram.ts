/**
 * SCRAM-SHA-256 authentication (RFC 5802 / RFC 7677), client side.
 *
 * Why this is implemented rather than falling back to a simpler mechanism:
 * `credential-and-secret-handling.md` requires the platform's own infrastructure
 * credentials be protected, and PostgreSQL's `md5` mechanism transmits a value
 * derived from an unsalted-per-session MD5 that is replayable against the server.
 * SCRAM is the mechanism modern PostgreSQL defaults to (`password_encryption =
 * scram-sha-256` since v14), so supporting anything less would in practice mean
 * asking every deployment tier to weaken its server configuration — a
 * configuration difference that changes a security property, which is precisely
 * what `environment-portability.md` says must not be needed to run on a tier.
 *
 * The server's final signature is verified rather than ignored. That check is what
 * makes the handshake mutual: without it, anything that can occupy the server's
 * address can collect a client proof. It costs one HMAC.
 */

import { createHash, createHmac, pbkdf2 as pbkdf2Callback, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const pbkdf2 = promisify(pbkdf2Callback);

const GS2_HEADER = 'n,,';
/** base64('n,,') — the channel-binding data for a client that does not bind. */
const GS2_HEADER_B64 = 'biws';

export const SCRAM_SHA_256 = 'SCRAM-SHA-256';

/**
 * Escape a username for the SCRAM attribute grammar.
 *
 * PostgreSQL ignores the username in the SCRAM exchange (it authenticates the
 * role from the startup packet), which is why `n=*` is conventional. Kept as a
 * function anyway so the reason is recorded rather than rediscovered.
 */
export function scramUsername(): string {
  return '*';
}

export interface ServerFirstMessage {
  readonly nonce: string;
  readonly salt: Buffer;
  readonly iterations: number;
}

/** Parse `r=<nonce>,s=<salt>,i=<iterations>`. */
export function parseServerFirst(message: string): ServerFirstMessage {
  const attributes = new Map<string, string>();
  for (const part of message.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) attributes.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const nonce = attributes.get('r');
  const salt = attributes.get('s');
  const iterations = attributes.get('i');
  if (nonce === undefined || salt === undefined || iterations === undefined) {
    throw new Error('SCRAM server-first-message is missing r, s, or i');
  }
  const count = Number(iterations);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error('SCRAM server-first-message has a non-integer iteration count');
  }
  return { nonce, salt: Buffer.from(salt, 'base64'), iterations: count };
}

/** Parse `v=<server signature>`, or surface `e=<error>` as a failure. */
export function parseServerFinal(message: string): Buffer {
  for (const part of message.split(',')) {
    if (part.startsWith('v=')) return Buffer.from(part.slice(2), 'base64');
    if (part.startsWith('e=')) throw new Error(`SCRAM exchange rejected by server: ${part.slice(2)}`);
  }
  throw new Error('SCRAM server-final-message contained neither a signature nor an error');
}

function hmac(key: Buffer, data: string | Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.allocUnsafe(a.length);
  for (let i = 0; i < a.length; i += 1) {
    out.writeUInt8(a.readUInt8(i) ^ b.readUInt8(i), i);
  }
  return out;
}

/**
 * A SCRAM exchange in progress.
 *
 * Modelled as an object with two steps rather than a single function because the
 * exchange spans two network round trips and the client nonce, the client-first
 * message, and the derived keys all have to survive between them. Holding that
 * state in the connection would spread the protocol across two files.
 */
export class ScramClient {
  readonly #clientNonce: string;
  readonly #clientFirstBare: string;
  #serverSignature: Buffer | undefined;

  constructor(clientNonce = randomBytes(18).toString('base64')) {
    this.#clientNonce = clientNonce;
    this.#clientFirstBare = `n=${scramUsername()},r=${clientNonce}`;
  }

  /** The SASLInitialResponse payload. */
  clientFirstMessage(): Buffer {
    return Buffer.from(`${GS2_HEADER}${this.#clientFirstBare}`, 'utf8');
  }

  /**
   * Produce the client-final message from the server's challenge.
   *
   * The server nonce must begin with the client nonce; a server that returns a
   * nonce it chose entirely is either broken or replaying, and continuing would
   * hand it a proof computed over a value it controls.
   */
  async clientFinalMessage(password: string, serverFirstRaw: string): Promise<Buffer> {
    const serverFirst = parseServerFirst(serverFirstRaw);
    if (!serverFirst.nonce.startsWith(this.#clientNonce)) {
      throw new Error('SCRAM server nonce does not extend the client nonce');
    }

    const saltedPassword = await pbkdf2(
      Buffer.from(password, 'utf8'),
      serverFirst.salt,
      serverFirst.iterations,
      32,
      'sha256',
    );
    const clientKey = hmac(saltedPassword, 'Client Key');
    const storedKey = createHash('sha256').update(clientKey).digest();

    const clientFinalWithoutProof = `c=${GS2_HEADER_B64},r=${serverFirst.nonce}`;
    const authMessage = `${this.#clientFirstBare},${serverFirstRaw},${clientFinalWithoutProof}`;

    const clientSignature = hmac(storedKey, authMessage);
    const proof = xor(clientKey, clientSignature);

    // Retained so `verifyServerFinal` can complete the mutual half of the
    // handshake without recomputing the expensive PBKDF2 derivation.
    this.#serverSignature = hmac(hmac(saltedPassword, 'Server Key'), authMessage);

    return Buffer.from(`${clientFinalWithoutProof},p=${proof.toString('base64')}`, 'utf8');
  }

  /**
   * Check the server proved it knows the stored key.
   *
   * Compared in constant time. The comparison is not itself secret-dependent in a
   * way an attacker can exploit here, but a variable-time compare in an
   * authentication path is the kind of detail that gets copied into one that is.
   */
  verifyServerFinal(serverFinalRaw: string): void {
    const expected = this.#serverSignature;
    if (expected === undefined) {
      throw new Error('SCRAM server-final-message arrived before the client-final message was sent');
    }
    const actual = parseServerFinal(serverFinalRaw);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error('SCRAM server signature did not verify');
    }
  }
}

/**
 * PostgreSQL's `md5` password response: `md5` + md5(md5(password + user) + salt).
 *
 * Supported because a deployment may still be pointed at a server configured with
 * `password_encryption = md5`, and refusing to connect would make the platform
 * unable to run on that tier — but it is not preferred, and `selectMechanism`
 * never chooses it when SCRAM is offered.
 */
export function md5Password(user: string, password: string, salt: Buffer): string {
  const inner = createHash('md5').update(`${password}${user}`, 'utf8').digest('hex');
  const outer = createHash('md5').update(Buffer.concat([Buffer.from(inner, 'utf8'), salt])).digest('hex');
  return `md5${outer}`;
}

/**
 * Choose the strongest mechanism the server offered that this client implements.
 *
 * `SCRAM-SHA-256-PLUS` is deliberately not selected. It binds the exchange to the
 * TLS channel, which is strictly better, but requires the server certificate's
 * signature — and selecting it while ignoring the binding would be worse than not
 * offering it at all.
 */
export function selectMechanism(offered: readonly string[]): string {
  if (offered.includes(SCRAM_SHA_256)) return SCRAM_SHA_256;
  throw new Error(
    `No supported SASL mechanism offered by the server (offered: ${offered.join(', ') || 'none'})`,
  );
}
