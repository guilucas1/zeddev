/**
 * The API service's environment schema.
 *
 * Only what is a property of *this* service lives here. Database, identity, mail,
 * and logging keys belong to the packages that read them and are loaded beside
 * this one at startup, so a key has exactly one declaration and one row in the
 * generated reference.
 *
 * Two keys in this file do more than their names suggest, and both are
 * `environment-portability.md` AC5 decisions — configured rather than detected:
 *
 * - `API_PUBLIC_BASE_URL` is the one statement of where clients reach the
 *   platform. The verification and reset links are built from it, its scheme
 *   decides whether the session cookie is marked `Secure`, and its origin is the
 *   only `Origin` a state-changing request may carry. Inferring any of those from
 *   the incoming `Host` header would let a caller choose the domain a password
 *   reset link points at — the classic host-header poisoning attack.
 * - `API_TRUSTED_PROXY_HOPS` says how many reverse proxies stand in front of the
 *   service. A laptop has none, a VPS usually one, a managed platform one or two.
 *   Guessing — "trust X-Forwarded-For when it is present" — lets any caller name
 *   their own source address and walk straight past the per-source throttle
 *   `authentication-and-access.md` AC12 requires.
 */

import { loadConfig, type Config, type ConfigSchema, type RawEnv } from '@zeddev/config';
import { ConfigurationError } from '@zeddev/errors';

export const API_CONFIG_SCHEMA = {
  API_HTTP_HOST: {
    type: 'string',
    description:
      'Address the HTTP listener binds to. The default listens on every interface, which is what a container needs; set it to a loopback address to keep a process on a shared host reachable only through a local reverse proxy.',
    default: '0.0.0.0',
  },
  API_HTTP_PORT: {
    type: 'integer',
    description: 'TCP port the HTTP listener binds to. 0 asks the operating system for any free port, which is only useful to a test harness.',
    default: 8080,
    min: 0,
    max: 65535,
  },
  API_PUBLIC_BASE_URL: {
    type: 'url',
    protocols: ['http', 'https'],
    description:
      'Public URL at which clients reach the platform, with the dashboard and the API served from one origin. Verification and password-reset links are built from it; an https URL marks session cookies Secure; and its origin is the only Origin a state-changing request is accepted from. Never derived from the request, because a link built from a caller-supplied Host header lets the caller choose where a password-reset link points.',
    example: 'https://example.com',
  },
  API_TRUSTED_PROXY_HOPS: {
    type: 'integer',
    description:
      'Number of reverse proxies in front of this service whose X-Forwarded-For entries are trusted. 0 means the TCP peer is the client. Too high lets a caller forge their own source address and escape the per-source throttle; too low makes every client share the proxy\'s address and one noisy client throttles them all.',
    default: 0,
    min: 0,
    max: 10,
  },
  API_ANONYMOUS_RATE_LIMIT: {
    type: 'integer',
    description:
      'Unauthenticated requests one source may make to the credential and recovery endpoints (signup, login, verification, password reset) per API_ANONYMOUS_RATE_WINDOW. The per-source half of the login throttle authentication-and-access.md AC12 requires; the per-account half is IDENTITY_LOGIN_MAX_FAILED_ATTEMPTS. Counted per process, so N instances admit up to N times this.',
    default: 30,
    min: 1,
    max: 100_000,
  },
  API_ANONYMOUS_RATE_WINDOW: {
    type: 'duration',
    description: 'Window over which API_ANONYMOUS_RATE_LIMIT is counted.',
    default: 10 * 60 * 1000,
    min: 1000,
  },
  API_MAX_BODY_BYTES: {
    type: 'integer',
    description:
      'Largest request body accepted, in bytes. Every request this service takes is a small JSON document, and the bound is what stops a caller making the password hasher chew on megabytes.',
    default: 16 * 1024,
    min: 1024,
    max: 1024 * 1024,
  },
  API_REQUEST_TIMEOUT: {
    type: 'duration',
    description:
      'How long one request may take to arrive in full and be answered before the connection is dropped. Bounds how long a slow client can hold a connection open.',
    default: 30_000,
    min: 1000,
  },
  API_SHUTDOWN_GRACE: {
    type: 'duration',
    description:
      'On a stop signal, how long in-flight requests and queued outbound mail are given to finish before connections are closed. Should be shorter than the orchestrator\'s own kill timeout, or the process is killed mid-drain.',
    default: 10_000,
    min: 0,
  },
} as const satisfies ConfigSchema;

export type ApiConfig = Config<typeof API_CONFIG_SCHEMA>;

/** What the request handler needs, already parsed. */
export interface ApiSettings {
  /** Normalised to end in `/`, so relative link paths resolve beneath any path prefix. */
  readonly publicBaseUrl: URL;
  readonly publicOrigin: string;
  /** Derived from the base URL's scheme — a configured value, not a detected one. */
  readonly secureCookies: boolean;
  readonly trustedProxyHops: number;
  readonly anonymousRateLimit: number;
  readonly anonymousRateWindowMs: number;
  readonly maxBodyBytes: number;
}

/** What the listener needs, in addition. */
export interface ServerSettings extends ApiSettings {
  readonly host: string;
  readonly port: number;
  readonly requestTimeoutMs: number;
  readonly shutdownGraceMs: number;
}

export function loadServerSettings(env: RawEnv = process.env): ServerSettings {
  const config = loadConfig(API_CONFIG_SCHEMA, env);
  const base = new URL(config.API_PUBLIC_BASE_URL);
  // A query or fragment on the base would be silently discarded by link
  // building, which is a behaviour the configured value does not explain.
  if (base.search !== '' || base.hash !== '' || base.username !== '' || base.password !== '') {
    throw new ConfigurationError([
      {
        key: 'API_PUBLIC_BASE_URL',
        reason: 'must not carry credentials, a query string, or a fragment',
      },
    ]);
  }
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;

  return {
    publicBaseUrl: base,
    publicOrigin: base.origin,
    secureCookies: base.protocol === 'https:',
    trustedProxyHops: config.API_TRUSTED_PROXY_HOPS,
    anonymousRateLimit: config.API_ANONYMOUS_RATE_LIMIT,
    anonymousRateWindowMs: config.API_ANONYMOUS_RATE_WINDOW,
    maxBodyBytes: config.API_MAX_BODY_BYTES,
    host: config.API_HTTP_HOST,
    port: config.API_HTTP_PORT,
    requestTimeoutMs: config.API_REQUEST_TIMEOUT,
    shutdownGraceMs: config.API_SHUTDOWN_GRACE,
  };
}
