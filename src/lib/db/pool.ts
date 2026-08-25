/**
 * Connection pool.
 *
 * Pooling is what makes the tenant-context design in `tenant.ts` safe, and the
 * two have to be read together. Binding a tenant to a session with `SET` would be
 * catastrophic under a pool: the setting would outlive the request and the next
 * borrower of that connection would run as the previous tenant. `SET LOCAL` (via
 * `set_config(..., true)`) is scoped to the transaction, so it cannot outlive it —
 * which is why every tenant-scoped operation in this platform runs inside a
 * transaction, and why this pool refuses to hand back a connection that is still
 * inside one.
 *
 * Sizing is a `cost-efficient-operation.md` concern as much as a performance one.
 * PostgreSQL allocates real memory per backend, so an oversized pool on a low-cost
 * VPS is a fixed cost paid whether or not any tenant is active. The maximum is
 * configuration, never a constant, so the same image runs with two connections on
 * a laptop and twenty on a managed instance — `environment-portability.md`'s
 * "differences explainable purely by configured resource limits".
 */

import { TransientTransportError } from '@zeddev/errors';
import { SystemClock, type Clock } from '@zeddev/time';
import { Connection, type ConnectionOptions, type QueryResult } from './connection.ts';

export interface PoolOptions extends ConnectionOptions {
  /** Maximum simultaneous server connections. */
  readonly maxConnections: number;
  /** How long a caller waits for a connection before failing. */
  readonly acquireTimeoutMs: number;
  /** How long an unused connection is kept before being closed. */
  readonly idleTimeoutMs: number;
  readonly clock?: Clock | undefined;
}

interface IdleEntry {
  readonly connection: Connection;
  readonly idleSinceMs: number;
}

interface Waiter {
  readonly resolve: (connection: Connection) => void;
  readonly reject: (error: unknown) => void;
  readonly cancelTimer: () => void;
}

export class Pool {
  readonly #options: PoolOptions;
  readonly #clock: Clock;
  #idle: IdleEntry[] = [];
  #leased = new Set<Connection>();
  #waiters: Waiter[] = [];
  #total = 0;
  #ending = false;

  constructor(options: PoolOptions) {
    this.#options = options;
    this.#clock = options.clock ?? new SystemClock();
  }

  /** Connections currently checked out. Exposed so a health check can report saturation. */
  get leasedCount(): number {
    return this.#leased.size;
  }

  get idleCount(): number {
    return this.#idle.length;
  }

  get totalCount(): number {
    return this.#total;
  }

  /** Callers waiting for a connection. A sustained non-zero value means the pool is undersized. */
  get waitingCount(): number {
    return this.#waiters.length;
  }

  async acquire(): Promise<Connection> {
    if (this.#ending) {
      throw new TransientTransportError('The connection pool is shutting down', {
        code: 'db.pool_closed',
      });
    }

    this.#reapIdle();

    const reused = this.#idle.pop();
    if (reused !== undefined) {
      this.#leased.add(reused.connection);
      return reused.connection;
    }

    if (this.#total < this.#options.maxConnections) {
      // Counted before connecting, so that concurrent acquires cannot each see
      // room and collectively overshoot the configured maximum — which on a
      // small VPS is the difference between a working deployment and one the
      // server refuses connections to.
      this.#total += 1;
      try {
        const connection = new Connection(this.#options);
        await connection.connect();
        this.#leased.add(connection);
        return connection;
      } catch (error) {
        this.#total -= 1;
        throw error;
      }
    }

    return this.#waitForConnection();
  }

  #waitForConnection(): Promise<Connection> {
    return new Promise<Connection>((resolvePromise, rejectPromise) => {
      const cancelTimer = this.#clock.setTimer(this.#options.acquireTimeoutMs, () => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        rejectPromise(
          new TransientTransportError('Timed out waiting for a database connection', {
            code: 'db.acquire_timeout',
            context: { elapsedMs: this.#options.acquireTimeoutMs, count: this.#leased.size },
          }),
        );
      });
      const waiter: Waiter = { resolve: resolvePromise, reject: rejectPromise, cancelTimer };
      this.#waiters.push(waiter);
    });
  }

  /**
   * Return a connection to the pool.
   *
   * A connection left inside a transaction is rolled back rather than reused as
   * is. That case means a caller escaped `transaction()` — a defect — but the
   * damage if it were ignored is not a slow query, it is the next borrower
   * inheriting an open transaction and, with it, the previous caller's tenant
   * binding. Rolling back is cheap; the alternative is a cross-tenant read that
   * `tenant-data-isolation.md` states must be impossible.
   */
  async release(connection: Connection): Promise<void> {
    this.#leased.delete(connection);
    connection.boundTenantId = undefined;

    if (connection.isClosed) {
      this.#total -= 1;
      this.#pumpWaiters();
      return;
    }

    if (connection.transactionStatus !== 'I') {
      try {
        await connection.query('ROLLBACK');
      } catch {
        // The rollback itself failing means the connection is unusable. Discard
        // it rather than returning a connection in an unknown transaction state.
        await connection.close();
        this.#total -= 1;
        this.#pumpWaiters();
        return;
      }
    }

    if (this.#ending) {
      await connection.close();
      this.#total -= 1;
      return;
    }

    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.cancelTimer();
      this.#leased.add(connection);
      waiter.resolve(connection);
      return;
    }

    this.#idle.push({ connection, idleSinceMs: this.#clock.monotonicMs() });
  }

  #pumpWaiters(): void {
    // A connection was destroyed rather than returned, so capacity opened up
    // without a connection to hand over. Waiters are woken to retry acquisition,
    // which will build a fresh connection.
    if (this.#waiters.length === 0 || this.#total >= this.#options.maxConnections) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) return;
    waiter.cancelTimer();
    this.acquire().then(waiter.resolve, waiter.reject);
  }

  /**
   * Close connections idle for longer than the configured timeout.
   *
   * Called on acquisition rather than from a background timer. A timer would keep
   * the event loop alive and would run whether or not the platform is doing
   * anything — a small always-on cost of exactly the kind
   * `cost-efficient-operation.md` objects to. Reaping on demand means an idle
   * deployment does nothing at all.
   */
  #reapIdle(): void {
    if (this.#idle.length === 0) return;
    const cutoff = this.#clock.monotonicMs() - this.#options.idleTimeoutMs;
    const expired = this.#idle.filter((entry) => entry.idleSinceMs <= cutoff);
    if (expired.length === 0) return;
    this.#idle = this.#idle.filter((entry) => entry.idleSinceMs > cutoff);
    for (const entry of expired) {
      this.#total -= 1;
      void entry.connection.close();
    }
  }

  /** Borrow a connection for the duration of `fn`, returning it however `fn` ends. */
  async withConnection<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    const connection = await this.acquire();
    try {
      return await fn(connection);
    } finally {
      await this.release(connection);
    }
  }

  /** Run a single statement on a borrowed connection. */
  async query<Row = Record<string, unknown>>(
    sql: string,
    parameters: readonly unknown[] = [],
  ): Promise<QueryResult<Row>> {
    return this.withConnection((connection) => connection.query<Row>(sql, parameters));
  }

  /**
   * Run `fn` inside a transaction, committing on success and rolling back on any
   * throw.
   *
   * The rollback is itself wrapped, because the most common reason a transaction
   * body throws is that the connection died — and a rollback on a dead connection
   * throws too. Letting that second failure escape would replace the caller's
   * real error with a misleading one, and `message-delivery-reliability.md`
   * depends on the original error's class to decide whether to retry.
   */
  async transaction<T>(fn: (connection: Connection) => Promise<T>): Promise<T> {
    return this.withConnection(async (connection) => {
      await connection.query('BEGIN');
      try {
        const result = await fn(connection);
        await connection.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch {
          // Preserve the original failure; see above.
        }
        throw error;
      }
    });
  }

  /** Close every connection. Leased connections are closed as they are returned. */
  async end(): Promise<void> {
    this.#ending = true;
    for (const waiter of this.#waiters) {
      waiter.cancelTimer();
      waiter.reject(
        new TransientTransportError('The connection pool is shutting down', { code: 'db.pool_closed' }),
      );
    }
    this.#waiters = [];
    const idle = this.#idle;
    this.#idle = [];
    this.#total -= idle.length;
    await Promise.all(idle.map((entry) => entry.connection.close()));
  }
}
