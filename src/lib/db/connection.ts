/**
 * A single PostgreSQL connection.
 *
 * The design constraint that shapes this file is that exactly one statement may
 * be in flight at a time. The protocol permits pipelining, but pipelining makes
 * error recovery ambiguous — when the server reports a failure, which of the
 * queued statements failed, and which of the rest were skipped? Serialising is a
 * throughput cost the pool pays back by holding several connections, and it buys
 * an unambiguous mapping from every failure to the statement that caused it,
 * which is what `operator-health-monitoring.md` needs in order to attribute an
 * error to a tenant at all.
 *
 * Asynchronous notifications are handled out of band, because they arrive at any
 * point in the message stream — including between a `RowDescription` and its
 * rows. Treating one as part of a query result would corrupt the result set. This
 * is what `LISTEN` support for the job queue is built on: a worker can wait for
 * work to arrive rather than polling, which is the difference between idle cost
 * proportional to poll frequency and idle cost near zero, per
 * `cost-efficient-operation.md`.
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { ConfigurationError, TransientTransportError, type ZedError } from '@zeddev/errors';
import type { Secret } from '@zeddev/secrets';
import { decodeValue, encodeParam, rowCountFromTag } from './codec.ts';
import { mapPostgresFailure, toPostgresFailure } from './errors.ts';
import { md5Password, ScramClient, selectMechanism } from './scram.ts';
import {
  bindMessage,
  describeMessage,
  executeMessage,
  parseDataRow,
  parseErrorFields,
  parseMessage,
  parseNotification,
  parseRowDescription,
  queryMessage,
  saslInitialResponseMessage,
  saslResponseMessage,
  passwordMessage,
  splitMessages,
  sslRequestMessage,
  startupMessage,
  SYNC_MESSAGE,
  TERMINATE_MESSAGE,
  type BackendNotification,
  type FieldDescription,
} from './wire.ts';

/**
 * TLS negotiation modes, matching libpq's vocabulary.
 *
 * The vocabulary is borrowed rather than invented so that an operator who has
 * configured PostgreSQL access anywhere else already knows what the values mean —
 * `environment-portability.md` forbids "tribal-knowledge steps", and a bespoke
 * set of TLS mode names is a small piece of exactly that.
 */
export const SSL_MODES = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'] as const;
export type SslMode = (typeof SSL_MODES)[number];

export interface ConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: Secret<string> | undefined;
  readonly database: string;
  readonly applicationName: string;
  readonly sslMode: SslMode;
  readonly connectTimeoutMs: number;
  /**
   * Server-side cap on how long any single statement may run.
   *
   * Applied as a session GUC in the startup packet rather than enforced by a
   * client-side timer, because a client-side timeout abandons a query that the
   * server keeps executing — holding locks that block every other tenant's work
   * and producing exactly the cross-tenant interference `tenant-data-isolation.md`
   * AC5 forbids.
   */
  readonly statementTimeoutMs: number;
  /** PEM certificate authority bundle, when the server's CA is not a public root. */
  readonly caCertificate?: string | undefined;
}

export interface QueryResult<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
  readonly command: string;
  readonly fields: readonly FieldDescription[];
}

type NotificationHandler = (notification: BackendNotification) => void;

interface PendingOperation {
  readonly resolve: (results: QueryResult[]) => void;
  readonly reject: (error: unknown) => void;
  results: QueryResult[];
  fields: FieldDescription[];
  rows: Record<string, unknown>[];
  failure: ZedError | undefined;
}

const AUTH_OK = 0;
const AUTH_CLEARTEXT_PASSWORD = 3;
const AUTH_MD5_PASSWORD = 5;
const AUTH_SASL = 10;
const AUTH_SASL_CONTINUE = 11;
const AUTH_SASL_FINAL = 12;

export class Connection {
  readonly #options: ConnectionOptions;
  #socket: Socket | TLSSocket | undefined;
  #incoming: Buffer = Buffer.alloc(0);
  #pending: PendingOperation | undefined;
  #connectResolve: (() => void) | undefined;
  #connectReject: ((error: unknown) => void) | undefined;
  #scram: ScramClient | undefined;
  #notificationHandlers = new Set<NotificationHandler>();
  #parameters: Record<string, string> = {};
  #transactionStatus: 'I' | 'T' | 'E' = 'I';
  #closed = false;
  #fatal: unknown;
  #busy = false;

  /**
   * The tenant this session is currently bound to, if any.
   *
   * Set by `@zeddev/db`'s tenant-context helpers, read here so that a row-level-
   * security refusal can be reported as the specific cross-tenant violation
   * `tenant-data-isolation.md` AC9 describes rather than a generic permissions
   * error. Kept as a plain field because it is deliberately transparent: the
   * value it holds is an identifier, and hiding it would only make the audit
   * record harder to produce.
   */
  boundTenantId: string | undefined;

  constructor(options: ConnectionOptions) {
    this.#options = options;
  }

  get isClosed(): boolean {
    return this.#closed;
  }

  /** `I` idle, `T` in a transaction, `E` in a failed transaction. */
  get transactionStatus(): 'I' | 'T' | 'E' {
    return this.#transactionStatus;
  }

  /** Server-reported session parameters, e.g. `server_version`. */
  get serverParameters(): Readonly<Record<string, string>> {
    return this.#parameters;
  }

  // -------------------------------------------------------------------------
  // Connection establishment
  // -------------------------------------------------------------------------

  async connect(): Promise<void> {
    const socket = await this.#openSocket();
    const upgraded = await this.#negotiateTls(socket);
    this.#attach(upgraded);

    const ready = new Promise<void>((resolvePromise, rejectPromise) => {
      this.#connectResolve = resolvePromise;
      this.#connectReject = rejectPromise;
    });

    this.#write(
      startupMessage({
        user: this.#options.user,
        database: this.#options.database,
        application_name: this.#options.applicationName,
        client_encoding: 'UTF8',
        // See `wire.ts` startupMessage: these three make the server's text
        // output deterministic, so decoding never depends on server config.
        DateStyle: 'ISO, MDY',
        TimeZone: 'UTC',
        extra_float_digits: '3',
        statement_timeout: String(this.#options.statementTimeoutMs),
      }),
    );

    await ready;
  }

  #openSocket(): Promise<Socket> {
    return new Promise((resolvePromise, rejectPromise) => {
      const socket = netConnect({ host: this.#options.host, port: this.#options.port });
      // Keepalive rather than a heartbeat query. A NAT or load balancer that
      // silently drops an idle connection is the most common cause of a pooled
      // connection that looks alive and fails on first use.
      socket.setKeepAlive(true, 30_000);
      socket.setNoDelay(true);

      const timer = setTimeout(() => {
        socket.destroy();
        rejectPromise(
          new TransientTransportError('Timed out establishing a database connection', {
            code: 'db.connect_timeout',
            context: { elapsedMs: this.#options.connectTimeoutMs },
          }),
        );
      }, this.#options.connectTimeoutMs);
      timer.unref?.();

      socket.once('connect', () => {
        clearTimeout(timer);
        resolvePromise(socket);
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        rejectPromise(
          new TransientTransportError('Could not reach the database', {
            code: 'db.connect_failed',
            context: { errorType: error.constructor.name },
            cause: error,
          }),
        );
      });
    });
  }

  /**
   * Perform the pre-startup TLS negotiation.
   *
   * The server answers the SSL request with a single unframed byte, which is why
   * this runs before the framed message reader is attached. `prefer` is the only
   * mode that accepts a refusal; every other non-`disable` mode treats plaintext
   * as a failure rather than transparently downgrading, because a silent
   * downgrade would mean the deployment believes it has transport protection it
   * does not have.
   */
  #negotiateTls(socket: Socket): Promise<Socket | TLSSocket> {
    const mode = this.#options.sslMode;
    if (mode === 'disable') return Promise.resolve(socket);

    return new Promise((resolvePromise, rejectPromise) => {
      socket.once('data', (response: Buffer) => {
        const answer = String.fromCharCode(response.readUInt8(0));
        if (answer === 'N') {
          if (mode === 'prefer') {
            resolvePromise(socket);
            return;
          }
          socket.destroy();
          rejectPromise(
            new ConfigurationError([
              {
                key: 'DATABASE_SSL_MODE',
                reason: `the server refused TLS but the configured mode is "${mode}"; set it to "prefer" or "disable" only if unencrypted transport is acceptable for this deployment`,
              },
            ]),
          );
          return;
        }
        if (answer !== 'S') {
          socket.destroy();
          rejectPromise(
            new TransientTransportError('Unexpected response to the TLS negotiation request', {
              code: 'db.tls_negotiation_failed',
            }),
          );
          return;
        }

        const verify = mode === 'verify-ca' || mode === 'verify-full';
        const tlsSocket = tlsConnect({
          socket,
          servername: this.#options.host,
          rejectUnauthorized: verify,
          // `verify-ca` checks the chain but not the hostname; `verify-full`
          // checks both. Distinguishing them matters for a managed cloud
          // instance whose certificate names the provider's endpoint rather
          // than the address the platform was configured with.
          ...(mode === 'verify-ca' ? { checkServerIdentity: () => undefined } : {}),
          ...(this.#options.caCertificate === undefined ? {} : { ca: this.#options.caCertificate }),
        });
        tlsSocket.once('secureConnect', () => resolvePromise(tlsSocket));
        tlsSocket.once('error', (error) =>
          rejectPromise(
            new ConfigurationError([
              { key: 'DATABASE_SSL_MODE', reason: `TLS handshake failed: ${error.constructor.name}` },
            ]),
          ),
        );
      });
      socket.write(sslRequestMessage());
    });
  }

  #attach(socket: Socket | TLSSocket): void {
    this.#socket = socket;
    socket.on('data', (chunk: Buffer) => this.#receive(chunk));
    socket.on('error', (error) => this.#die(error));
    socket.on('close', () =>
      this.#die(
        new TransientTransportError('The database connection closed unexpectedly', {
          code: 'db.connection_closed',
        }),
      ),
    );
  }

  #write(payload: Buffer): void {
    this.#socket?.write(payload);
  }

  /**
   * Tear down after an unrecoverable failure.
   *
   * Every waiter is rejected with the same cause. Leaving a caller's promise
   * pending after the socket has gone is how a worker ends up hung rather than
   * restarting, and `message-delivery-reliability.md` AC6 depends on a restart
   * actually happening so acknowledged work is picked back up.
   */
  #die(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#fatal ??= error;
    this.#socket?.destroy();
    this.#connectReject?.(error);
    this.#connectResolve = undefined;
    this.#connectReject = undefined;
    const pending = this.#pending;
    this.#pending = undefined;
    this.#busy = false;
    pending?.reject(error);
  }

  // -------------------------------------------------------------------------
  // Message dispatch
  // -------------------------------------------------------------------------

  #receive(chunk: Buffer): void {
    this.#incoming = this.#incoming.length === 0 ? chunk : Buffer.concat([this.#incoming, chunk]);
    const { messages, rest } = splitMessages(this.#incoming);
    this.#incoming = rest;
    for (const message of messages) {
      try {
        this.#dispatch(message.type, message.body);
      } catch (error) {
        this.#die(error);
        return;
      }
    }
  }

  #dispatch(type: string, body: Buffer): void {
    switch (type) {
      case 'R':
        void this.#handleAuthentication(body);
        return;
      case 'S': {
        // ParameterStatus. Arrives during startup and whenever a session GUC
        // changes, including ones this client set itself.
        let offset = 0;
        const nul = body.indexOf(0, offset);
        const name = body.toString('utf8', offset, nul);
        offset = nul + 1;
        const end = body.indexOf(0, offset);
        this.#parameters[name] = body.toString('utf8', offset, end === -1 ? body.length : end);
        return;
      }
      case 'K':
        // BackendKeyData. Only needed to cancel a running query out of band,
        // which this client does not do — `statement_timeout` covers the case
        // server-side, and does so without a second connection.
        return;
      case 'Z': {
        const status = String.fromCharCode(body.readUInt8(0));
        this.#transactionStatus = status === 'T' || status === 'E' ? status : 'I';
        this.#settle();
        return;
      }
      case 'T':
        this.#requirePending().fields = parseRowDescription(body);
        return;
      case 'D': {
        const pending = this.#requirePending();
        const values = parseDataRow(body);
        const row: Record<string, unknown> = {};
        pending.fields.forEach((field, index) => {
          const raw = values[index] ?? null;
          row[field.name] = raw === null ? null : decodeValue(field.typeOid, raw);
        });
        pending.rows.push(row);
        return;
      }
      case 'C': {
        // CommandComplete ends one statement. The simple query protocol can
        // deliver several per Sync, so each is flushed into `results` and the
        // row accumulator reset rather than appended to.
        const pending = this.#requirePending();
        const tag = new TextDecoder().decode(body.subarray(0, Math.max(body.length - 1, 0)));
        pending.results.push({
          rows: pending.rows,
          rowCount: rowCountFromTag(tag),
          command: tag.split(' ')[0] ?? tag,
          fields: pending.fields,
        });
        pending.rows = [];
        pending.fields = [];
        return;
      }
      case 'I':
        // EmptyQueryResponse — an empty statement string. Recorded so the caller
        // sees a result per statement rather than a silently shorter array.
        this.#requirePending().results.push({ rows: [], rowCount: 0, command: '', fields: [] });
        return;
      case 'E': {
        const failure = toPostgresFailure(parseErrorFields(body));
        const error = mapPostgresFailure(failure, { boundTenantId: this.boundTenantId });
        const pending = this.#pending;
        if (pending === undefined) {
          // A failure outside any query means startup failed.
          this.#connectReject?.(error);
          this.#connectResolve = undefined;
          this.#connectReject = undefined;
          this.#closed = true;
          this.#socket?.destroy();
          return;
        }
        // Recorded, not thrown. The backend continues to ReadyForQuery, and
        // settling before then would leave the next caller reading this
        // statement's trailing messages as if they were its own.
        pending.failure = error;
        return;
      }
      case 'N':
        // NoticeResponse. Deliberately dropped: its text is written by the
        // server and can quote row data, which under
        // `operator-health-monitoring.md` AC9 must not reach a log.
        return;
      case 'A': {
        const notification = parseNotification(body);
        for (const handler of this.#notificationHandlers) handler(notification);
        return;
      }
      case '1': // ParseComplete
      case '2': // BindComplete
      case '3': // CloseComplete
      case 'n': // NoData
      case 't': // ParameterDescription
      case 's': // PortalSuspended
        return;
      default:
        throw new TransientTransportError('Unrecognised backend message', {
          code: 'db.unknown_message',
          context: { messageType: type },
        });
    }
  }

  #requirePending(): PendingOperation {
    const pending = this.#pending;
    if (pending === undefined) {
      throw new TransientTransportError('Received query data with no query in flight', {
        code: 'db.protocol_desync',
      });
    }
    return pending;
  }

  #settle(): void {
    if (this.#connectResolve !== undefined) {
      const resolveConnect = this.#connectResolve;
      this.#connectResolve = undefined;
      this.#connectReject = undefined;
      resolveConnect();
      return;
    }
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    this.#busy = false;
    if (pending.failure !== undefined) pending.reject(pending.failure);
    else pending.resolve(pending.results);
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  async #handleAuthentication(body: Buffer): Promise<void> {
    const kind = body.readInt32BE(0);
    const password = this.#options.password?.expose();

    const requirePassword = (): string => {
      if (password === undefined) {
        throw new ConfigurationError([
          {
            key: 'DATABASE_PASSWORD',
            reason: 'the server requested password authentication but no password was configured',
          },
        ]);
      }
      return password;
    };

    try {
      switch (kind) {
        case AUTH_OK:
          return;
        case AUTH_CLEARTEXT_PASSWORD:
          this.#write(passwordMessage(requirePassword()));
          return;
        case AUTH_MD5_PASSWORD:
          this.#write(
            passwordMessage(md5Password(this.#options.user, requirePassword(), body.subarray(4, 8))),
          );
          return;
        case AUTH_SASL: {
          const offered: string[] = [];
          let offset = 4;
          for (;;) {
            const end = body.indexOf(0, offset);
            if (end === -1 || end === offset) break;
            offered.push(body.toString('utf8', offset, end));
            offset = end + 1;
          }
          const mechanism = selectMechanism(offered);
          const scram = new ScramClient();
          this.#scram = scram;
          requirePassword();
          this.#write(saslInitialResponseMessage(mechanism, scram.clientFirstMessage()));
          return;
        }
        case AUTH_SASL_CONTINUE: {
          const scram = this.#scram;
          if (scram === undefined) throw new Error('SASL continuation arrived before the exchange began');
          const final = await scram.clientFinalMessage(requirePassword(), body.subarray(4).toString('utf8'));
          this.#write(saslResponseMessage(final));
          return;
        }
        case AUTH_SASL_FINAL:
          this.#scram?.verifyServerFinal(body.subarray(4).toString('utf8'));
          this.#scram = undefined;
          return;
        default:
          throw new ConfigurationError([
            {
              key: 'DATABASE_USER',
              reason: `the server requested an unsupported authentication method (code ${kind})`,
            },
          ]);
      }
    } catch (error) {
      this.#die(error);
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  #start(): Promise<QueryResult[]> {
    if (this.#closed) {
      return Promise.reject(
        this.#fatal ??
          new TransientTransportError('The database connection is closed', { code: 'db.closed' }),
      );
    }
    if (this.#busy) {
      // A defect rather than a race to wait out: the pool hands each caller an
      // exclusive connection, so two concurrent statements mean a caller kept a
      // reference past its lease.
      return Promise.reject(
        new TransientTransportError('A statement is already in flight on this connection', {
          code: 'db.connection_busy',
        }),
      );
    }
    this.#busy = true;
    return new Promise<QueryResult[]>((resolvePromise, rejectPromise) => {
      this.#pending = {
        resolve: resolvePromise,
        reject: rejectPromise,
        results: [],
        fields: [],
        rows: [],
        failure: undefined,
      };
    });
  }

  /**
   * Run a parameterised statement.
   *
   * Uses the unnamed prepared statement, so nothing is cached between calls. That
   * is deliberate. A named-statement cache is the standard optimisation, and it
   * is also the standard source of `cached plan must not change result type`
   * outages: the migration runner alters a column, and every pooled connection
   * holding a plan compiled against the old shape starts failing until it is
   * recycled. Re-planning costs microseconds; a self-inflicted outage during a
   * deploy costs a great deal more, and `component-independence.md` AC1 requires
   * that deploying one component not disturb the others.
   */
  async query<Row = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    const settled = this.#start();
    this.#write(
      Buffer.concat([
        parseMessage('', sql),
        bindMessage('', '', parameters.map(encodeParam)),
        describeMessage('P', ''),
        executeMessage('', 0),
        SYNC_MESSAGE,
      ]),
    );
    const results = await settled;
    const last = results[results.length - 1];
    return (last ?? { rows: [], rowCount: 0, command: '', fields: [] }) as QueryResult<Row>;
  }

  /**
   * Run one or more statements with no parameters, via the simple query protocol.
   *
   * This exists for migrations. The extended protocol accepts exactly one
   * statement per Parse, so a migration file containing a `CREATE TABLE` and its
   * `CREATE INDEX` cannot go through `query`. The simple protocol also wraps a
   * multi-statement string in an implicit transaction, so a migration that fails
   * halfway leaves nothing behind — which is what makes the migration runner's
   * all-or-nothing claim true rather than aspirational.
   *
   * Takes no parameters, and that is a safety property: every value in a string
   * passed here is literal SQL, so this must never be reachable from caller
   * input. `query` is the only path that accepts data.
   */
  async simpleQuery(sql: string): Promise<QueryResult[]> {
    const settled = this.#start();
    this.#write(queryMessage(sql));
    return settled;
  }

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /** Subscribe to `NOTIFY` payloads. Returns an unsubscribe function. */
  onNotification(handler: NotificationHandler): () => void {
    this.#notificationHandlers.add(handler);
    return () => {
      this.#notificationHandlers.delete(handler);
    };
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const socket = this.#socket;
    if (socket === undefined) return;
    // Terminate is best-effort: a server that has already gone will not read it,
    // and waiting for an acknowledgement that cannot arrive would make shutdown
    // hang. `component-independence.md` AC2 needs a restart to be quick.
    socket.write(TERMINATE_MESSAGE);
    await new Promise<void>((resolvePromise) => {
      socket.end(() => resolvePromise());
      const timer = setTimeout(() => resolvePromise(), 1000);
      timer.unref?.();
    });
    socket.destroy();
  }
}
