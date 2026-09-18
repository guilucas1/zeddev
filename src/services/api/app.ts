/**
 * The client and operator HTTP API — where `@zeddev/identity` becomes something a
 * browser can reach.
 *
 * Everything true about identity is decided in `@zeddev/identity` and tested there
 * against a real PostgreSQL. This file owns only what that package deliberately
 * left out: status codes, cookies, the per-source throttle, the cross-site request
 * defences, and composing the mail that carries each token to the mailbox it
 * names. A rule found here that decides who someone is, or what they may do, is in
 * the wrong package.
 *
 * ## The request pipeline, in order
 *
 * 1. **Route by exact path.** No parameters and no prefix matching, so there is no
 *    parser in which a crafted path could select a different handler.
 * 2. **Refuse a foreign `Origin`** on anything that changes state.
 * 3. **Throttle unauthenticated credential and recovery requests** per source
 *    (`authentication-and-access.md` AC12, the "from a single source" half).
 * 4. **Run the handler**, which returns a `Reply` value or throws.
 * 5. **Map a thrown error through `toReply`**, which is the only place a failure
 *    becomes something the caller sees.
 * 6. **Log one record**, carrying the matched route pattern — never the raw path.
 *
 * ## Two identity spaces, two cookies
 *
 * The client session and the operator session travel in different cookies, and
 * the operator's is scoped to `Path=/v1/operator`, so a browser never even sends
 * it to a client surface. That is a convenience, not the guarantee: the guarantee
 * is that `@zeddev/identity` refuses a token of the wrong kind before looking
 * anything up (AC21, AC22), and the tests present each token at the other's
 * surface to prove it.
 *
 * ## Why there is no tenant anywhere in a request
 *
 * `authentication-and-access.md` AC4 requires the tenant a request acts on be
 * "the one bound to that session by the system", with no caller-supplied tenant
 * honoured. No handler here reads a tenant from a path, query, header, or body.
 * The tenant arrives only as a field of the `ClientPrincipal` the session
 * resolves to.
 */

import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  clearBehaviorInstructions,
  clearFreeformInstructions,
  createBehaviorRule,
  deleteBehaviorRule,
  describeBehaviorRule,
  describeBehaviorRules,
  describeBotStatus,
  describeFallbackMessages,
  describePersona,
  listBotStatuses,
  parseActivationInput,
  previewFallbackDraft,
  readActivationHistory,
  readBehaviorRules,
  readBotStatus,
  readFallbackMessages,
  readPersona,
  saveBehaviorInstructions,
  saveFallbackMessages,
  savePersona,
  setBehaviorRuleEnabled,
  setBotActive,
  updateBehaviorRule,
} from '@zeddev/bot';
import type { Connection, Pool } from '@zeddev/db';
import { AuthenticationError, TransientTransportError, ValidationError } from '@zeddev/errors';
import type { Action, ClientPrincipal, IdentityService } from '@zeddev/identity';
import { Logger } from '@zeddev/logging';
import type { Mailer } from '@zeddev/mail';
import { SystemClock, type Clock } from '@zeddev/time';
import { connectionHistory, describeConnection, disconnectWhatsApp, readConnection } from '@zeddev/whatsapp';
import type { ApiSettings } from './config.ts';
import {
  clientAddress,
  HttpError,
  parseCookies,
  readJsonObject,
  SECURITY_HEADERS,
  serializeCookie,
  stringFields,
  toReply,
  type Reply,
} from './http.ts';
import { MailOutbox, passwordResetMessage, verificationMessage } from './mail.ts';
import { FixedWindowRateLimiter } from './ratelimit.ts';

export const CLIENT_SESSION_COOKIE = 'zd_session';
export const OPERATOR_SESSION_COOKIE = 'zd_operator_session';
export const CLIENT_COOKIE_PATH = '/';
export const OPERATOR_COOKIE_PATH = '/v1/operator';

export interface ApiDependencies {
  readonly identity: IdentityService;
  readonly mailer: Mailer;
  /** Used only by the readiness probe. Every data access goes through `identity`. */
  readonly pool: Pool;
  readonly settings: ApiSettings;
  readonly logger?: Logger | undefined;
  readonly clock?: Clock | undefined;
}

export interface Api {
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void;
  readonly outbox: MailOutbox;
}

interface RequestContext {
  readonly request: IncomingMessage;
  readonly requestId: string;
  readonly cookies: ReadonlyMap<string, string>;
  body(): Promise<Record<string, unknown>>;
}

interface Route {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly path: string;
  /** Counted against the per-source budget for unauthenticated credential and recovery requests. */
  readonly anonymous?: boolean;
  /** Logged at debug rather than info — probes arrive every few seconds and say nothing. */
  readonly quiet?: boolean;
  readonly handle: (context: RequestContext) => Promise<Reply>;
}

const ACCEPTED = { status: 'accepted' } as const;

export function createApi(dependencies: ApiDependencies): Api {
  const { identity, pool, settings } = dependencies;
  const clock = dependencies.clock ?? new SystemClock();
  const logger = (dependencies.logger ?? new Logger()).child({ component: 'api' });
  const outbox = new MailOutbox(dependencies.mailer, logger);
  const limiter = new FixedWindowRateLimiter({
    limit: settings.anonymousRateLimit,
    windowMs: settings.anonymousRateWindowMs,
    clock,
  });

  const clientCookie = (token: string, expires: Date | undefined): string =>
    serializeCookie(CLIENT_SESSION_COOKIE, token, {
      path: CLIENT_COOKIE_PATH,
      secure: settings.secureCookies,
      expires,
    });
  const operatorCookie = (token: string, expires: Date | undefined): string =>
    serializeCookie(OPERATOR_SESSION_COOKIE, token, {
      path: OPERATOR_COOKIE_PATH,
      secure: settings.secureCookies,
      expires,
    });

  /**
   * The presented session token, or an authentication failure without asking the
   * database. A request carrying no credential at all is not an authentication
   * attempt, and recording one per anonymous page load would fill the append-only
   * access log with nothing.
   */
  function sessionToken(context: RequestContext, cookie: string): string {
    const token = context.cookies.get(cookie);
    if (token === undefined || token === '') throw new AuthenticationError();
    return token;
  }

  /**
   * Run tenant-scoped work for the session's client, as one named action.
   *
   * Every tenant-scoped route goes through here and therefore through
   * `IdentityService.withClientAction`: the tenant comes from the session, the
   * action is checked against `ACTION_PRINCIPALS` and recorded, and only then is
   * a transaction bound to that tenant opened. An operator's token presented in the
   * client cookie is refused at resolution (AC22) before any of that.
   */
  function asClient<T>(
    context: RequestContext,
    action: Action,
    resource: string,
    fn: (connection: Connection, principal: ClientPrincipal) => Promise<T>,
  ): Promise<T> {
    return identity.withClientAction(sessionToken(context, CLIENT_SESSION_COOKIE), action, resource, fn);
  }

  const routes: readonly Route[] = [
    // -----------------------------------------------------------------------
    // Probes. Separate so an orchestrator can tell "the process is wedged"
    // (restart it) from "the database is unreachable" (restarting will not help),
    // and so the operator can see *which* component is down —
    // `component-independence.md` AC9.
    // -----------------------------------------------------------------------
    {
      method: 'GET',
      path: '/health/live',
      quiet: true,
      handle: async () => ({ status: 200, body: { status: 'live' } }),
    },
    {
      method: 'GET',
      path: '/health/ready',
      quiet: true,
      handle: async () => {
        try {
          await pool.query('SELECT 1');
          return { status: 200, body: { status: 'ready' } };
        } catch (error) {
          logger.warn('api.readiness.failed', { component: 'database', errorType: errorName(error) });
          return { status: 503, body: { status: 'unavailable', component: 'database' } };
        }
      },
    },

    // -----------------------------------------------------------------------
    // Signup and verification — client-signup-and-tenancy.md.
    // -----------------------------------------------------------------------
    {
      method: 'POST',
      path: '/v1/signup',
      anonymous: true,
      handle: async (context) => {
        const input = stringFields(await context.body(), ['businessName', 'email', 'password']);
        const signed = await identity.signUp(input);
        // The token goes to the mailbox and nowhere else. Returning it here would
        // hand the link to whoever submitted the form, which is exactly the
        // person the verification exists to distrust.
        outbox.dispatch(
          'email_verification',
          verificationMessage({
            base: settings.publicBaseUrl,
            to: signed.email,
            token: signed.verificationToken,
            expiresAt: signed.verificationExpiresAt,
          }),
        );
        return { status: 201, body: { status: 'verification_pending' } };
      },
    },
    {
      method: 'POST',
      path: '/v1/email-verification',
      anonymous: true,
      handle: async (context) => {
        const { token } = stringFields(await context.body(), ['token']);
        try {
          await identity.verifyEmail(token);
        } catch (error) {
          if (error instanceof ValidationError || error instanceof TransientTransportError) throw error;
          // Anything else escaping `verifyEmail` failed after the token was
          // accepted, which means provisioning failed; identity has already rolled
          // it back and marked the tenant `failed`. AC7 requires the client be
          // shown that state rather than a generic error, and the token was left
          // unconsumed so the same link can be retried.
          logger.error('api.signup.provisioning_failed', error, { requestId: context.requestId });
          throw new HttpError(500, 'signup.provisioning_failed');
        }
        return { status: 200, body: { status: 'verified' } };
      },
    },
    {
      method: 'POST',
      path: '/v1/email-verification/requests',
      anonymous: true,
      handle: async (context) => {
        const { email } = stringFields(await context.body(), ['email']);
        const issued = await identity.requestEmailVerification(email);
        if (issued !== undefined) {
          outbox.dispatch(
            'email_verification',
            verificationMessage({
              base: settings.publicBaseUrl,
              to: issued.email,
              token: issued.token,
              expiresAt: issued.expiresAt,
            }),
          );
        }
        // The same reply whether or not there was anything to send — the caller
        // contract `requestEmailVerification` documents.
        return { status: 202, body: ACCEPTED };
      },
    },

    // -----------------------------------------------------------------------
    // Self-service password recovery — authentication-and-access.md AC8–AC11.
    // -----------------------------------------------------------------------
    {
      method: 'POST',
      path: '/v1/password-resets/requests',
      anonymous: true,
      handle: async (context) => {
        const { email } = stringFields(await context.body(), ['email']);
        const issued = await identity.requestPasswordReset(email);
        if (issued !== undefined) {
          outbox.dispatch(
            'password_reset',
            passwordResetMessage({
              base: settings.publicBaseUrl,
              to: issued.email,
              token: issued.token,
              expiresAt: issued.expiresAt,
            }),
          );
        }
        // AC9: identical for a registered and an unregistered address, in body
        // and — because delivery happens after this returns — in timing.
        return { status: 202, body: ACCEPTED };
      },
    },
    {
      method: 'POST',
      path: '/v1/password-resets',
      anonymous: true,
      handle: async (context) => {
        const input = stringFields(await context.body(), ['token', 'newPassword']);
        await identity.resetPassword(input);
        // Every session for the account was just revoked; clearing this browser's
        // cookie too means it stops presenting a token that can only be refused.
        return { status: 204, cookies: [clientCookie('', undefined)] };
      },
    },

    // -----------------------------------------------------------------------
    // Client sessions.
    // -----------------------------------------------------------------------
    {
      method: 'POST',
      path: '/v1/session',
      anonymous: true,
      handle: async (context) => {
        const input = stringFields(await context.body(), ['email', 'password']);
        const session = await identity.logIn(input);
        return {
          status: 200,
          cookies: [clientCookie(session.token.expose(), session.absoluteExpiresAt)],
          body: { principalType: 'client', expiresAt: session.absoluteExpiresAt.toISOString() },
        };
      },
    },
    {
      method: 'GET',
      path: '/v1/session',
      handle: async (context) => {
        const principal = await identity.resolveClientSession(sessionToken(context, CLIENT_SESSION_COOKIE));
        return {
          status: 200,
          body: { principalType: 'client', accountId: principal.accountId, tenantId: principal.tenantId },
        };
      },
    },
    {
      method: 'DELETE',
      path: '/v1/session',
      handle: async (context) => {
        const token = context.cookies.get(CLIENT_SESSION_COOKIE);
        // The same reply whether a session was ended or there was none: a logout
        // that says "no such session" is a token-validity oracle reachable without
        // authentication.
        if (token !== undefined && token !== '') await identity.logOut(token);
        return { status: 204, cookies: [clientCookie('', undefined)] };
      },
    },
    {
      method: 'POST',
      path: '/v1/account/password',
      handle: async (context) => {
        const principal = await identity.resolveClientSession(sessionToken(context, CLIENT_SESSION_COOKIE));
        const input = stringFields(await context.body(), ['currentPassword', 'newPassword']);
        await identity.changePassword({ principal, ...input });
        // AC8: the change ended every session, this one included.
        return { status: 204, cookies: [clientCookie('', undefined)] };
      },
    },

    // -----------------------------------------------------------------------
    // Bot configuration — persona and tone (persona-and-tone-configuration.md).
    // The rules live in @zeddev/bot; each route is one action on the session's
    // own tenant, and none of them can name another.
    // -----------------------------------------------------------------------
    {
      method: 'GET',
      path: '/v1/bot/persona',
      handle: async (context) => {
        const persona = await asClient(context, 'tenant.configuration.read', 'bot.persona', (tx) => readPersona(tx));
        return { status: 200, body: describePersona(persona) };
      },
    },
    {
      // PUT because a save replaces the whole persona: an optional field left out
      // of the body is cleared, not kept. The body is read before the session is
      // resolved so that a malformed request costs no database round trip.
      method: 'PUT',
      path: '/v1/bot/persona',
      handle: async (context) => {
        const body = await context.body();
        const persona = await asClient(context, 'tenant.configuration.write', 'bot.persona', (tx) =>
          savePersona(tx, body),
        );
        return { status: 200, body: describePersona(persona) };
      },
    },
    {
      // Clearing the freeform text on its own, without resubmitting the
      // structured fields — the spec's "independently of the structured fields".
      method: 'DELETE',
      path: '/v1/bot/persona/freeform-instructions',
      handle: async (context) => {
        const persona = await asClient(context, 'tenant.configuration.write', 'bot.persona', (tx) =>
          clearFreeformInstructions(tx),
        );
        return { status: 200, body: describePersona(persona) };
      },
    },

    // -----------------------------------------------------------------------
    // Behaviour rules — behavior-rules-configuration.md. Routing is by exact
    // path only, so an individual rule is named by the `id` in the JSON body,
    // never by a path segment. A rule id that is not the session's own tenant's
    // is "not found", indistinguishable from one that never existed.
    // -----------------------------------------------------------------------
    {
      method: 'GET',
      path: '/v1/bot/behavior-rules',
      handle: async (context) => {
        const configuration = await asClient(context, 'tenant.configuration.read', 'bot.behavior_rules', (tx) =>
          readBehaviorRules(tx),
        );
        return { status: 200, body: describeBehaviorRules(configuration) };
      },
    },
    {
      method: 'POST',
      path: '/v1/bot/behavior-rules',
      handle: async (context) => {
        const body = await context.body();
        const rule = await asClient(context, 'tenant.configuration.write', 'bot.behavior_rules', (tx) =>
          createBehaviorRule(tx, body),
        );
        return { status: 201, body: { rule: describeBehaviorRule(rule) } };
      },
    },
    {
      // PUT because an edit replaces the rule's whole definition.
      method: 'PUT',
      path: '/v1/bot/behavior-rules/rule',
      handle: async (context) => {
        const body = await context.body();
        const rule = await asClient(context, 'tenant.configuration.write', 'bot.behavior_rules', (tx) =>
          updateBehaviorRule(tx, body),
        );
        return { status: 200, body: { rule: describeBehaviorRule(rule) } };
      },
    },
    {
      // `{ "id", "enabled": true | false }`: the desired state, not a toggle, so a
      // retried request cannot flip the rule back.
      method: 'PUT',
      path: '/v1/bot/behavior-rules/rule/enabled',
      handle: async (context) => {
        const body = await context.body();
        const rule = await asClient(context, 'tenant.configuration.write', 'bot.behavior_rules', (tx) =>
          setBehaviorRuleEnabled(tx, body),
        );
        return { status: 200, body: { rule: describeBehaviorRule(rule) } };
      },
    },
    {
      // POST rather than DELETE-with-a-body, which intermediaries may drop.
      method: 'POST',
      path: '/v1/bot/behavior-rules/rule/delete',
      handle: async (context) => {
        const body = await context.body();
        await asClient(context, 'tenant.configuration.write', 'bot.behavior_rules', (tx) =>
          deleteBehaviorRule(tx, body),
        );
        return { status: 204 };
      },
    },
    {
      method: 'PUT',
      path: '/v1/bot/behavior-rules/freeform-instructions',
      handle: async (context) => {
        const body = await context.body();
        const configuration = await asClient(context, 'tenant.configuration.write', 'bot.behavior_rules', async (tx) => {
          await saveBehaviorInstructions(tx, body);
          return readBehaviorRules(tx);
        });
        return { status: 200, body: describeBehaviorRules(configuration) };
      },
    },
    {
      method: 'DELETE',
      path: '/v1/bot/behavior-rules/freeform-instructions',
      handle: async (context) => {
        const configuration = await asClient(context, 'tenant.configuration.write', 'bot.behavior_rules', async (tx) => {
          await clearBehaviorInstructions(tx);
          return readBehaviorRules(tx);
        });
        return { status: 200, body: describeBehaviorRules(configuration) };
      },
    },

    // -----------------------------------------------------------------------
    // Fallback messages — fallback-response-behavior.md. Every view carries the
    // resolved preview, computed by the same function the reply path uses.
    // -----------------------------------------------------------------------
    {
      method: 'GET',
      path: '/v1/bot/fallback-messages',
      handle: async (context) => {
        const configuration = await asClient(context, 'tenant.configuration.read', 'bot.fallback_messages', (tx) =>
          readFallbackMessages(tx),
        );
        return { status: 200, body: describeFallbackMessages(configuration) };
      },
    },
    {
      // PUT because a save replaces the whole configuration: a message left out
      // is cleared, and clearing every message returns to the platform defaults.
      method: 'PUT',
      path: '/v1/bot/fallback-messages',
      handle: async (context) => {
        const body = await context.body();
        const configuration = await asClient(context, 'tenant.configuration.write', 'bot.fallback_messages', (tx) =>
          saveFallbackMessages(tx, body),
        );
        return { status: 200, body: describeFallbackMessages(configuration) };
      },
    },
    {
      // A draft, previewed without saving (AC12, "before they take effect"). It
      // reads no tenant data, but still requires the session: an unauthenticated
      // endpoint that echoes submitted text back is an open reflector.
      method: 'POST',
      path: '/v1/bot/fallback-messages/preview',
      handle: async (context) => {
        const body = await context.body();
        const preview = await asClient(context, 'tenant.configuration.read', 'bot.fallback_messages', async () =>
          previewFallbackDraft(body),
        );
        return { status: 200, body: { preview } };
      },
    },

    // -----------------------------------------------------------------------
    // Readiness and the go-live toggle — bot-activation-control.md. The rules
    // (what "ready" is, that an active bot must stay ready) live in the database
    // and @zeddev/bot; these routes only read them and carry the client's toggle.
    // -----------------------------------------------------------------------
    {
      method: 'GET',
      path: '/v1/bot/status',
      handle: async (context) => {
        const status = await asClient(context, 'tenant.configuration.read', 'bot.status', (tx) => readBotStatus(tx));
        return { status: 200, body: describeBotStatus(status) };
      },
    },
    {
      // PUT `{ "active": true | false }`: the desired state, not a toggle, so a
      // retried request cannot flip the bot back.
      method: 'PUT',
      path: '/v1/bot/activation',
      handle: async (context) => {
        const active = parseActivationInput(await context.body());
        const status = await asClient(context, 'tenant.activation.change', 'bot.activation', (tx) =>
          setBotActive(tx, active),
        );
        return { status: 200, body: describeBotStatus(status) };
      },
    },
    {
      method: 'GET',
      path: '/v1/bot/activation/history',
      handle: async (context) => {
        const events = await asClient(context, 'tenant.configuration.read', 'bot.activation', (tx) =>
          readActivationHistory(tx),
        );
        return {
          status: 200,
          body: {
            events: events.map((event) => ({
              active: event.active,
              cause: event.cause,
              occurredAt: event.occurredAt.toISOString(),
            })),
          },
        };
      },
    },

    // -----------------------------------------------------------------------
    // WhatsApp connection state — whatsapp-number-connection.md. Connecting a
    // number needs the gateway (P2); what exists now is the state, its history,
    // and the client's manual disconnect.
    // -----------------------------------------------------------------------
    {
      method: 'GET',
      path: '/v1/whatsapp/connection',
      handle: async (context) => {
        const body = await asClient(context, 'tenant.configuration.read', 'whatsapp.connection', async (tx) =>
          describeConnection(await readConnection(tx), await connectionHistory(tx)),
        );
        return { status: 200, body };
      },
    },
    {
      method: 'POST',
      path: '/v1/whatsapp/connection/disconnect',
      handle: async (context) => {
        const body = await asClient(context, 'whatsapp.connection.manage', 'whatsapp.connection', async (tx) => {
          await disconnectWhatsApp(tx);
          return describeConnection(await readConnection(tx), await connectionHistory(tx));
        });
        return { status: 200, body };
      },
    },

    // -----------------------------------------------------------------------
    // Operator sessions — a separate identity space on separate routes, with a
    // separate cookie. There is no operator signup and there must not be one.
    // -----------------------------------------------------------------------
    {
      method: 'POST',
      path: '/v1/operator/session',
      anonymous: true,
      handle: async (context) => {
        const input = stringFields(await context.body(), ['email', 'password']);
        const session = await identity.operatorLogIn(input);
        return {
          status: 200,
          cookies: [operatorCookie(session.token.expose(), session.absoluteExpiresAt)],
          body: { principalType: 'operator', expiresAt: session.absoluteExpiresAt.toISOString() },
        };
      },
    },
    {
      method: 'GET',
      path: '/v1/operator/session',
      handle: async (context) => {
        const principal = await identity.resolveOperatorSession(
          sessionToken(context, OPERATOR_SESSION_COOKIE),
        );
        return { status: 200, body: { principalType: 'operator', operatorId: principal.operatorId } };
      },
    },
    {
      method: 'DELETE',
      path: '/v1/operator/session',
      handle: async (context) => {
        const token = context.cookies.get(OPERATOR_SESSION_COOKIE);
        if (token !== undefined && token !== '') await identity.operatorLogOut(token);
        return { status: 204, cookies: [operatorCookie('', undefined)] };
      },
    },
    {
      method: 'POST',
      path: '/v1/operator/account/password',
      handle: async (context) => {
        const principal = await identity.resolveOperatorSession(
          sessionToken(context, OPERATOR_SESSION_COOKIE),
        );
        const input = stringFields(await context.body(), ['currentPassword', 'newPassword']);
        await identity.changeOperatorPassword({ principal, ...input });
        return { status: 204, cookies: [operatorCookie('', undefined)] };
      },
    },
    {
      // bot-activation-control.md AC12: every tenant's readiness and activation,
      // read-only. There is no operator route that changes activation, and the
      // action table would refuse one (`tenant.activation.change` is client-only).
      method: 'GET',
      path: '/v1/operator/bot-statuses',
      handle: async (context) => {
        const tenants = await identity.withOperatorAction(
          sessionToken(context, OPERATOR_SESSION_COOKIE),
          'platform.health.read',
          'bot.status',
          (tx) => listBotStatuses(tx),
        );
        return { status: 200, body: { tenants } };
      },
    },
  ];

  const byPath = new Map<string, Route[]>();
  for (const route of routes) {
    const list = byPath.get(route.path) ?? [];
    list.push(route);
    byPath.set(route.path, list);
  }

  async function dispatch(
    request: IncomingMessage,
    requestId: string,
  ): Promise<{ route: Route | undefined; reply: Reply; failure?: unknown }> {
    // The query string and fragment are dropped before matching. No route reads
    // them, which is also what makes a `?tenantId=` parameter inert (AC4).
    const path = (request.url ?? '/').split(/[?#]/, 1)[0]!;
    const candidates = byPath.get(path);
    if (candidates === undefined) {
      return { route: undefined, reply: toReply(new HttpError(404, 'route.not_found'), requestId) };
    }
    const route = candidates.find((candidate) => candidate.method === request.method);
    if (route === undefined) {
      const allow = candidates.map((candidate) => candidate.method).join(', ');
      return {
        route: undefined,
        reply: toReply(new HttpError(405, 'route.method_not_allowed', { allow }), requestId),
      };
    }

    try {
      if (route.method !== 'GET') {
        const origin = request.headers.origin;
        // A browser attaches `Origin` to every cross-origin request and to
        // same-origin ones that change state, so a mismatch is a page on another
        // site trying to act with this site's cookies. Absent is allowed: that is
        // a non-browser client, which has no ambient credentials to abuse.
        if (origin !== undefined && origin !== settings.publicOrigin) {
          throw new HttpError(403, 'request.cross_origin');
        }
      }

      if (route.anonymous === true) {
        const source = clientAddress(
          request.socket.remoteAddress,
          request.headers['x-forwarded-for'],
          settings.trustedProxyHops,
        );
        const decision = limiter.take(source);
        if (!decision.allowed) {
          throw new HttpError(429, 'request.rate_limited', {
            'retry-after': String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
          });
        }
      }

      const context: RequestContext = {
        request,
        requestId,
        cookies: parseCookies(request.headers.cookie),
        body: () => readJsonObject(request, settings.maxBodyBytes),
      };
      return { route, reply: await route.handle(context) };
    } catch (error) {
      return { route, reply: toReply(error, requestId), failure: error };
    }
  }

  function write(response: ServerResponse, reply: Reply, requestId: string): void {
    const headers: Record<string, string | string[]> = {
      ...SECURITY_HEADERS,
      ...(reply.headers ?? {}),
      'x-request-id': requestId,
    };
    if (reply.cookies !== undefined && reply.cookies.length > 0) headers['set-cookie'] = [...reply.cookies];
    if (reply.body === undefined) {
      response.writeHead(reply.status, headers);
      response.end();
      return;
    }
    const payload = JSON.stringify(reply.body);
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = String(Buffer.byteLength(payload));
    response.writeHead(reply.status, headers);
    response.end(payload);
  }

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const requestId = randomUUID();
    const started = performance.now();

    void dispatch(request, requestId).then(({ route, reply, failure }) => {
      try {
        if (!response.headersSent && !response.destroyed) write(response, reply, requestId);
      } catch (error) {
        // `dispatch` never rejects, so this is the only failure left: the socket
        // went away mid-write. Nothing can be told to the caller; the record
        // below still says what the reply would have been.
        logger.warn('api.response.write_failed', { requestId, errorType: errorName(error) });
        response.destroy();
      }

      const fields = {
        requestId,
        method: request.method ?? 'UNKNOWN',
        route: route?.path ?? 'unmatched',
        statusCode: reply.status,
        durationMs: Math.round(performance.now() - started),
      };
      if (reply.status >= 500) {
        logger.error('api.request.failed', failure, fields);
      } else if (route?.quiet === true) {
        logger.debug('api.request', fields);
      } else {
        logger.info('api.request', fields);
      }
    });
  };

  return { handler, outbox };
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}
