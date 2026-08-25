/**
 * Database configuration inputs.
 *
 * Declared as discrete keys rather than as a single connection URL, and that is
 * the one decision in this file worth arguing about.
 *
 * A URL is more familiar and shorter to write. It is also a string containing a
 * password, which makes every accidental disclosure of it — a log line, an error
 * message, a process listing, a crash dump — a credential disclosure.
 * `credential-and-secret-handling.md` AC5 requires that no log, diagnostic
 * record, error message, metric, alert, or notification contain a secret value,
 * and a URL makes that guarantee depend on nobody ever printing the one config
 * value most likely to be printed while debugging a connection problem. Discrete
 * keys let exactly one of them — `DATABASE_PASSWORD` — be marked `secret`, so it
 * arrives wrapped in `Secret` and cannot be serialised by accident, while the
 * host and database name stay plainly visible where they are useful.
 *
 * Discrete keys also satisfy `environment-portability.md` AC6 better: the
 * generated reference lists TLS mode, pool size, and timeouts as inputs an
 * operator can see and reason about, rather than burying them in URL query
 * parameters whose spelling has to be known in advance.
 */

import type { ConfigSchema } from '@zeddev/config';
import { SSL_MODES } from './connection.ts';

export const DATABASE_CONFIG_SCHEMA = {
  DATABASE_HOST: {
    type: 'string',
    description: 'Hostname or address of the PostgreSQL server.',
    example: 'postgres',
  },
  DATABASE_PORT: {
    type: 'integer',
    description: 'TCP port of the PostgreSQL server.',
    default: 5432,
    min: 1,
    max: 65535,
  },
  DATABASE_NAME: {
    type: 'string',
    description: 'Database to connect to.',
    example: 'zeddev',
  },
  DATABASE_USER: {
    type: 'string',
    description: 'Role to authenticate as.',
    example: 'zeddev',
  },
  DATABASE_PASSWORD: {
    type: 'string',
    description: 'Password for the database role.',
    secret: true,
  },
  DATABASE_SSL_MODE: {
    type: 'enum',
    values: SSL_MODES,
    description:
      'TLS negotiation mode, using libpq vocabulary. "disable" is appropriate only when the database is reached over a trusted local network, such as a container network on a single host.',
    default: 'prefer',
  },
  DATABASE_CA_CERTIFICATE: {
    type: 'string',
    description:
      'PEM certificate authority bundle, for a server whose certificate is not signed by a public root. Empty means use the system trust store.',
    default: '',
  },
  DATABASE_POOL_MAX: {
    type: 'integer',
    description:
      'Maximum simultaneous database connections held by this process. Each one costs memory on the server, so this is the main lever for fitting the platform onto a small host.',
    default: 10,
    min: 1,
    max: 500,
  },
  DATABASE_ACQUIRE_TIMEOUT: {
    type: 'duration',
    description: 'How long a request waits for a free connection before failing.',
    default: 10_000,
    min: 100,
  },
  DATABASE_IDLE_TIMEOUT: {
    type: 'duration',
    description: 'How long an unused connection is kept open before being closed.',
    default: 30_000,
    min: 1000,
  },
  DATABASE_CONNECT_TIMEOUT: {
    type: 'duration',
    description: 'How long to wait for a TCP connection to the database to be established.',
    default: 10_000,
    min: 100,
  },
  DATABASE_STATEMENT_TIMEOUT: {
    type: 'duration',
    description:
      'Server-side limit on how long any single statement may run. Enforced by the server so that an abandoned query cannot keep holding locks that block other tenants.',
    default: 30_000,
    min: 100,
  },
} as const satisfies ConfigSchema;
