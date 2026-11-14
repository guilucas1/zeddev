/**
 * The byte transport, and the seam that makes the SMTP client testable.
 *
 * `SmtpConnector` plays exactly the role `Transport` plays in `@zeddev/storage`,
 * and the division of labour is the same one IMPLEMENTATION_PLAN.md §4e records:
 * the seam covers what a real server will not produce on demand, never what it
 * will. A real SMTP server will happily demonstrate a greeting, EHLO
 * capabilities, AUTH, DATA, and dot-stuffing, so all of those are tested against
 * Mailpit. What it will not do on request is return a 451 in the middle of a
 * transaction, drop the connection after accepting the terminating dot, refuse to
 * advertise STARTTLS, or answer with a malformed reply — and those are exactly
 * the paths where the client's behaviour matters most and would otherwise be
 * unexercised.
 *
 * The seam is byte-oriented rather than line-oriented on purpose. SMTP replies
 * are lines, but line assembly — the multi-line `250-CAP` continuation form, a
 * reply split across two TCP segments, a segment carrying one and a half replies
 * — is precisely the part worth testing, and putting it above the seam means the
 * same parser runs against Mailpit and against a scripted connection. A
 * line-oriented seam would let the test hand the client whole tidy lines the
 * network never promises.
 */

import { isIP, connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { classifyTlsVerificationFailure, ConfigurationError, TransientTransportError } from '@zeddev/errors';

/**
 * The TLS options both ways into an encrypted session share.
 *
 * `host` is what the certificate is checked against. SNI (`servername`) may
 * only carry a name: RFC 6066 forbids an address, and Node warns that it will
 * stop sending one — the same correction `@zeddev/db` made when its test server
 * first spoke TLS. The system trust store is used unless MAIL_CA_CERTIFICATE
 * names an authority; there is deliberately no switch that turns verification
 * off, because a relay that cannot be verified cannot be told from an attacker
 * holding the password the client is about to send.
 */
function tlsOptions(host: string, caCertificate: string | undefined): {
  host: string;
  servername?: string;
  ca?: string;
} {
  return {
    host,
    ...(isIP(host) === 0 ? { servername: host } : {}),
    ...(caCertificate === undefined || caCertificate.length === 0 ? {} : { ca: caCertificate }),
  };
}

/**
 * A refused certificate is a configuration error naming the setting to change,
 * not a transient failure.
 *
 * Retrying it would spend MAIL_MAX_ATTEMPTS and their backoff rediscovering the
 * same verdict, and "could not reach the mail server" would send the operator to
 * look at the network when the fix is MAIL_HOST or MAIL_CA_CERTIFICATE
 * (`environment-portability.md` AC7). Which kind of refusal it was is judged by
 * `classifyTlsVerificationFailure`, shared with the database client. Anything
 * else — a reset mid-handshake, a peer that does not speak TLS — stays transient,
 * as before, and the phase it failed in names the keys.
 */
function certificateRefusal(error: Error, host: string): ConfigurationError | undefined {
  const verdict = classifyTlsVerificationFailure(error);
  if (verdict === undefined) return undefined;
  switch (verdict.kind) {
    case 'hostname':
      return new ConfigurationError(
        [
          {
            key: 'MAIL_HOST',
            reason: `the mail server's certificate does not name "${host}"; set MAIL_HOST to a name the certificate carries (${verdict.code})`,
          },
        ],
        { cause: error },
      );
    case 'authority':
      return new ConfigurationError(
        [
          {
            key: 'MAIL_CA_CERTIFICATE',
            reason: `the mail server's certificate is not signed by a trusted authority; set MAIL_CA_CERTIFICATE to the PEM bundle of the authority that signed it (${verdict.code})`,
          },
        ],
        { cause: error },
      );
    case 'validity':
      return new ConfigurationError(
        [{ key: 'MAIL_HOST', reason: `the mail server's certificate is outside its validity period (${verdict.code})` }],
        { cause: error },
      );
  }
}

export interface SmtpConnectOptions {
  readonly host: string;
  readonly port: number;
  /** Wrap the connection in TLS immediately, before the greeting. The `implicit` mode. */
  readonly tls: boolean;
  readonly caCertificate?: string | undefined;
  readonly connectTimeoutMs: number;
}

export interface SmtpConnection {
  /** Whether bytes are currently encrypted. Read after `startTls`, never cached across it. */
  readonly secure: boolean;
  write(data: Buffer): Promise<void>;
  /** The next chunk the server sent, or `undefined` once it has closed. */
  read(timeoutMs: number): Promise<Buffer | undefined>;
  /** Upgrade an established cleartext connection in place, after a 220 reply to STARTTLS. */
  startTls(options: { readonly host: string; readonly caCertificate?: string | undefined }): Promise<void>;
  close(): void;
}

export type SmtpConnector = (options: SmtpConnectOptions) => Promise<SmtpConnection>;

/**
 * A pull-based reader over a push-based socket.
 *
 * Node hands data to a listener whenever it arrives; the SMTP conversation wants
 * to ask for the next chunk when it is ready for one. Bridging the two needs a
 * queue, because bytes can arrive between the moment one reply is parsed and the
 * moment the next `read` is issued — and a chunk dropped there is a reply the
 * client waits forever for.
 */
class SocketConnection implements SmtpConnection {
  #socket: Socket | TLSSocket;
  #secure: boolean;
  #chunks: Buffer[] = [];
  #waiting: ((chunk: Buffer | undefined) => void) | undefined;
  #failure: Error | undefined;
  #ended = false;
  #closed = false;

  constructor(socket: Socket | TLSSocket, secure: boolean) {
    this.#socket = socket;
    this.#secure = secure;
    this.#attach();
  }

  get secure(): boolean {
    return this.#secure;
  }

  #attach(): void {
    this.#socket.on('data', (chunk: Buffer) => {
      const waiting = this.#waiting;
      if (waiting !== undefined) {
        this.#waiting = undefined;
        waiting(chunk);
        return;
      }
      this.#chunks.push(chunk);
    });
    this.#socket.on('end', () => {
      this.#ended = true;
      this.#wake();
    });
    this.#socket.on('close', () => {
      this.#ended = true;
      this.#wake();
    });
    this.#socket.on('error', (error: Error) => {
      this.#failure = error;
      this.#ended = true;
      this.#wake();
    });
  }

  #detach(): void {
    this.#socket.removeAllListeners('data');
    this.#socket.removeAllListeners('end');
    this.#socket.removeAllListeners('close');
    this.#socket.removeAllListeners('error');
  }

  #wake(): void {
    const waiting = this.#waiting;
    if (waiting === undefined) return;
    this.#waiting = undefined;
    waiting(undefined);
  }

  async write(data: Buffer): Promise<void> {
    if (this.#closed) {
      throw new TransientTransportError('Mail connection is closed', { code: 'mail.connection_closed' });
    }
    await new Promise<void>((resolve, reject) => {
      this.#socket.write(data, (error) => {
        if (error) {
          reject(
            new TransientTransportError('Failed writing to the mail server', {
              code: 'mail.write_failed',
              cause: error,
            }),
          );
          return;
        }
        resolve();
      });
    });
  }

  async read(timeoutMs: number): Promise<Buffer | undefined> {
    const buffered = this.#chunks.shift();
    if (buffered !== undefined) return buffered;
    if (this.#failure !== undefined) {
      const failure = this.#failure;
      throw new TransientTransportError('Mail connection failed', {
        code: 'mail.connection_failed',
        cause: failure,
      });
    }
    if (this.#ended) return undefined;

    return await new Promise<Buffer | undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiting = undefined;
        reject(
          new TransientTransportError('Timed out waiting for the mail server', {
            code: 'mail.read_timeout',
            context: { elapsedMs: timeoutMs },
          }),
        );
      }, timeoutMs);
      timer.unref?.();

      this.#waiting = (chunk) => {
        clearTimeout(timer);
        if (chunk === undefined && this.#failure !== undefined) {
          const failure = this.#failure;
          reject(
            new TransientTransportError('Mail connection failed', {
              code: 'mail.connection_failed',
              cause: failure,
            }),
          );
          return;
        }
        resolve(chunk);
      };
    });
  }

  async startTls(options: { readonly host: string; readonly caCertificate?: string | undefined }): Promise<void> {
    if (this.#secure) return;
    // Anything still queued arrived before the upgrade and therefore belongs to
    // the cleartext phase. A server that sent bytes after its 220 is either
    // broken or injecting, and carrying those bytes across the boundary is the
    // STARTTLS command-injection bug (CVE-2011-0411) — so they are refused
    // rather than discarded, because discarding is indistinguishable from the
    // attack succeeding quietly.
    if (this.#chunks.length > 0) {
      this.#chunks = [];
      throw new TransientTransportError('Mail server sent data before the TLS handshake', {
        code: 'mail.starttls_pipelined_data',
      });
    }
    this.#detach();
    const plain = this.#socket;
    const upgraded = await new Promise<TLSSocket>((resolve, reject) => {
      const secureSocket = tlsConnect(
        { socket: plain, ...tlsOptions(options.host, options.caCertificate) },
        () => resolve(secureSocket),
      );
      secureSocket.once('error', (error: Error) => {
        reject(
          certificateRefusal(error, options.host) ??
            new TransientTransportError('TLS handshake with the mail server failed', {
              code: 'mail.tls_handshake_failed',
              cause: error,
            }),
        );
      });
    });
    this.#socket = upgraded;
    this.#secure = true;
    this.#attach();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
  }
}

/** The real connector. Everything above this line is protocol; this is the wire. */
export function createConnector(): SmtpConnector {
  return async (options: SmtpConnectOptions): Promise<SmtpConnection> => {
    const socket = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        candidate.destroy();
        reject(
          (options.tls ? certificateRefusal(error, options.host) : undefined) ??
            new TransientTransportError('Could not reach the mail server', {
              code: 'mail.connect_failed',
              cause: error,
            }),
        );
      };
      const succeed = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        candidate.removeListener('error', fail);
        resolve(candidate);
      };

      const timer = setTimeout(() => {
        fail(new Error(`timed out after ${options.connectTimeoutMs}ms`));
      }, options.connectTimeoutMs);
      timer.unref?.();

      const candidate = options.tls
        ? tlsConnect({ port: options.port, ...tlsOptions(options.host, options.caCertificate) }, succeed)
        : netConnect({ host: options.host, port: options.port }, succeed);

      candidate.once('error', fail);
    });

    return new SocketConnection(socket, options.tls);
  };
}
