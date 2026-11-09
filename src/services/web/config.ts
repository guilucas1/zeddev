/**
 * The dashboard service's environment schema.
 *
 * Small on purpose: this service holds no data and reaches nothing but the API, so
 * the only thing about it that differs between tiers is where the API is.
 */

import { loadConfig, type Config, type ConfigSchema, type RawEnv } from '@zeddev/config';
import { ConfigurationError } from '@zeddev/errors';

export const WEB_CONFIG_SCHEMA = {
  WEB_HTTP_HOST: {
    type: 'string',
    description:
      'Address the HTTP listener binds to. The default listens on every interface, which is what a container needs; set it to a loopback address to keep a process on a shared host reachable only through a local reverse proxy.',
    default: '0.0.0.0',
  },
  WEB_HTTP_PORT: {
    type: 'integer',
    description: 'TCP port the HTTP listener binds to. 0 asks the operating system for any free port, which is only useful to a test harness.',
    default: 8082,
    min: 0,
    max: 65535,
  },
  WEB_API_UPSTREAM: {
    type: 'url',
    protocols: ['http', 'https'],
    description:
      'Where this service reaches the API, an origin with no path. Requests under /v1/ are forwarded there, which is how the dashboard and the API share the single origin API_PUBLIC_BASE_URL names: session cookies are SameSite=Strict and the API answers no CORS. This service counts as one proxy in front of the API, so API_TRUSTED_PROXY_HOPS must include it.',
    example: 'http://example.com:8080',
  },
  WEB_UPSTREAM_TIMEOUT: {
    type: 'duration',
    description:
      'How long a forwarded request may wait for the API before the browser is told the service is unavailable. It must outlast the slowest thing a dashboard asks for, a reply preview that makes a real AI call with retries.',
    default: 120_000,
    min: 1_000,
  },
  WEB_SHUTDOWN_GRACE: {
    type: 'duration',
    description: 'On a stop signal, how long requests in flight are given to finish before their connections are closed.',
    default: 10_000,
    min: 0,
  },
} as const satisfies ConfigSchema;

export type WebConfig = Config<typeof WEB_CONFIG_SCHEMA>;

export interface WebSettings {
  readonly host: string;
  readonly port: number;
  /** An origin: scheme, host, and port, with nothing after it. */
  readonly apiUpstream: URL;
  readonly upstreamTimeoutMs: number;
  readonly shutdownGraceMs: number;
}

export function loadWebSettings(env: RawEnv = process.env): WebSettings {
  const config = loadConfig(WEB_CONFIG_SCHEMA, env);
  const apiUpstream = new URL(config.WEB_API_UPSTREAM);
  // The forwarded path is the request's own. A base path here would be silently
  // dropped, sending every request somewhere other than where this value says.
  if (apiUpstream.pathname !== '/' || apiUpstream.search !== '' || apiUpstream.hash !== '' || apiUpstream.username !== '') {
    throw new ConfigurationError([{ key: 'WEB_API_UPSTREAM', reason: 'must be an origin, with no path, query, fragment, or credentials' }]);
  }
  return {
    host: config.WEB_HTTP_HOST,
    port: config.WEB_HTTP_PORT,
    apiUpstream,
    upstreamTimeoutMs: config.WEB_UPSTREAM_TIMEOUT,
    shutdownGraceMs: config.WEB_SHUTDOWN_GRACE,
  };
}
