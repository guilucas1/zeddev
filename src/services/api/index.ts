/**
 * `@zeddev/api` — the client and operator HTTP API.
 *
 * The process entrypoint is `main.ts`; the deployment bootstrap is `cli.ts`. What
 * is exported here is what a test, or a future service composing the same
 * handler, needs. The configuration schema is also reachable as
 * `@zeddev/api/config`, so `@zeddev/deployment` can generate the reference
 * without importing the server.
 */

export {
  CLIENT_COOKIE_PATH,
  CLIENT_SESSION_COOKIE,
  createApi,
  OPERATOR_COOKIE_PATH,
  OPERATOR_SESSION_COOKIE,
  type Api,
  type ApiDependencies,
} from './app.ts';
export { API_CONFIG_SCHEMA, loadServerSettings, type ApiSettings, type ServerSettings } from './config.ts';
export { clientAddress, HttpError, parseCookies, serializeCookie, toReply, type Reply } from './http.ts';
export { buildLink, LINK_PATHS, MailOutbox, passwordResetMessage, verificationMessage, type MailKind } from './mail.ts';
export { FixedWindowRateLimiter, type RateDecision } from './ratelimit.ts';
export { loadAll, startApi, type RunningApi, type StartOptions } from './start.ts';
export { runCli, type CliIo } from './cli.ts';
