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
  createKnowledgeEntry,
  deleteBehaviorRule,
  deleteKnowledgeEntry,
  describeBehaviorRule,
  describeBehaviorRules,
  describeBotStatus,
  describeDisclosureSetting,
  describeFallbackMessages,
  describeHandoffSettings,
  describeKnowledge,
  describeKnowledgeEntry,
  describeKnowledgeStatus,
  describePersona,
  listBotStatuses,
  parseActivationInput,
  parsePreviewInput,
  previewFallbackDraft,
  previewReply,
  readActivationHistory,
  readBehaviorRules,
  readBotStatus,
  readDisclosureSetting,
  readFallbackMessages,
  readHandoffSettings,
  readKnowledge,
  readPersona,
  readReplyConfiguration,
  saveBehaviorInstructions,
  saveDisclosureSetting,
  saveFallbackMessages,
  saveHandoffSettings,
  savePersona,
  setBehaviorRuleEnabled,
  setBotActive,
  setHandoffEnabled,
  updateBehaviorRule,
  updateKnowledgeEntry,
  type BotStatus,
} from '@zeddev/bot';
import type { AiProvider } from '@zeddev/ai';
import {
  describeConversationHandoff,
  describeConversationSummary,
  describeTranscript,
  listConversations,
  parseConversationListInput,
  parseResumeInput,
  parseTranscriptInput,
  parseVerificationInput,
  readTranscript,
  verifyAiProvider,
  resumeConversation,
} from '@zeddev/conversation';
import type { Connection, Pool } from '@zeddev/db';
import { AuthenticationError, TransientTransportError, ValidationError } from '@zeddev/errors';
import type { Action, ClientPrincipal, IdentityService } from '@zeddev/identity';
import { Logger } from '@zeddev/logging';
import type { Mailer } from '@zeddev/mail';
import {
  listConnectionHealth,
  listTenantHealth,
  parseTenantDetailInput,
  parseTenantHealthInput,
  readComponentStatus,
  readTenantHealth,
} from '@zeddev/monitoring';
import type { SecretSealer } from '@zeddev/secrets';
import { SystemClock, type Clock } from '@zeddev/time';
import {
  abandonVerification,
  beginVerification,
  CLOUD_RECOVERABLE_REASONS,
  cloudFailureReason,
  connectionCodeMessage,
  connectionHistory,
  describeCloudFailure,
  probeCloudLink,
  describeConnection,
  describeConnectionSetup,
  disconnectNumber,
  expireStaleVerification,
  generateVerificationCode,
  loadCloudCredentials,
  parseCredentialSubmission,
  parseVerificationRequest,
  readConnectedNumber,
  readConnection,
  readVerification,
  recordVerificationSent,
  submitCredentials,
  type CloudCredentials,
  type ConnectionErrorReason,
  type WhatsAppCloud,
} from '@zeddev/whatsapp';
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
  /** The platform's AI provider. Used by the reply preview, and described to the operator. */
  readonly ai: AiProvider;
  /**
   * The provider in the candidate slot (`AI_CANDIDATE_*`), if one is configured.
   * Reachable only through operator verification: no client route and no reply
   * path is given it, which is what keeps it off live conversations.
   */
  readonly candidateAi?: AiProvider | undefined;
  /** Meta's Cloud API, used by the connection flow to prove a number works. */
  readonly cloud: WhatsAppCloud;
  /**
   * Seals a tenant's WhatsApp access token before it is stored.
   *
   * Held by the service rather than reached for inside `@zeddev/whatsapp`
   * because the keys are configuration: a library that loaded its own key could
   * not be handed a different one in a test, and rotation would stop being
   * expressible.
   */
  readonly sealer: SecretSealer;
  /**
   * How long a client has to reply with their connection code
   * (`WHATSAPP_VERIFICATION_TTL`).
   *
   * Passed in rather than read from `ApiSettings` because it belongs to the
   * WhatsApp schema, which the gateway loads too — one key, one definition.
   */
  readonly verificationTtlMs: number;
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
  const { identity, pool, settings, ai, candidateAi, cloud, sealer, verificationTtlMs } = dependencies;
  const clock = dependencies.clock ?? new SystemClock();
  const logger = (dependencies.logger ?? new Logger()).child({ component: 'api' });
  const outbox = new MailOutbox(dependencies.mailer, logger);
  const limiter = new FixedWindowRateLimiter({
    limit: settings.anonymousRateLimit,
    windowMs: settings.anonymousRateWindowMs,
    clock,
  });
  // Keyed by tenant, not by source: what it protects is the AI provider's quota,
  // which one business's previews must not be able to spend for everyone.
  const previewLimiter = new FixedWindowRateLimiter({
    limit: settings.previewRateLimit,
    windowMs: settings.previewRateWindowMs,
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
  /**
   * Everything that has to hold at Meta before a connection code is worth
   * sending, and then the send.
   *
   * Ordered so the client gets the most actionable diagnosis first. Business
   * verification comes before anything technical because only Meta can resolve
   * it (AC9), and the subscription check comes before the send because a code
   * that goes out on an unsubscribed account leaves the client waiting for a
   * reply that can never arrive — the failure would look like "my phone did not
   * get it" rather than "this account does not deliver to the platform".
   *
   * Returns the failure rather than throwing it. A rejected token is the
   * client’s situation to act on, not a server fault, and a 500 with no reason
   * is exactly the opaque failure `whatsapp-number-connection.md` AC12 forbids.
   */
  async function probeAndSend(
    credentials: CloudCredentials,
    recipient: string,
    code: string,
  ): Promise<
    | {
        readonly sent: true;
        readonly outboundMessageId: string;
        readonly displayNumber: string;
        readonly verifiedName: string;
      }
    | {
        readonly sent: false;
        readonly reason: ConnectionErrorReason | 'transient';
        readonly description: string;
      }
  > {
    const refuse = (reason: ConnectionErrorReason | 'transient') =>
      ({ sent: false, reason, description: describeCloudFailure(reason) }) as const;
    try {
      const link = await probeCloudLink(cloud, credentials);
      if (!link.ok) return refuse(link.reason);
      const sent = await cloud.sendText(credentials, { to: recipient, body: connectionCodeMessage(code) });
      return {
        sent: true,
        outboundMessageId: sent.messageId,
        displayNumber: link.number.displayNumber,
        verifiedName: link.number.verifiedName,
      };
    } catch (error) {
      const reason = cloudFailureReason(error);
      // Anything this port did not classify is a defect here, not a connection
      // problem the client can fix, and must not be dressed up as one.
      if (reason === undefined) throw error;
      return refuse(reason);
    }
  }
  function asClient<T>(
    context: RequestContext,
    action: Action,
    resource: string,
    fn: (connection: Connection, principal: ClientPrincipal) => Promise<T>,
  ): Promise<T> {
    return identity.withClientAction(sessionToken(context, CLIENT_SESSION_COOKIE), action, resource, fn);
  }

  /**
   * The bot status screen's body: readiness and activation, plus whether the
   * optional business knowledge is configured. Read in the caller's transaction,
   * so both halves describe the same moment.
   */
  async function statusBody(tx: Connection, status: BotStatus) {
    return { ...describeBotStatus(status), businessKnowledge: describeKnowledgeStatus(await readKnowledge(tx)) };
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
    // Business knowledge — business-knowledge-configuration.md. Freeform entries,
    // each named by the `id` in the JSON body. Another tenant's entry id is "not
    // found", indistinguishable from one that never existed.
    // -----------------------------------------------------------------------
    {
      method: 'GET',
      path: '/v1/bot/knowledge',
      handle: async (context) => {
        const configuration = await asClient(context, 'tenant.configuration.read', 'bot.knowledge', (tx) =>
          readKnowledge(tx),
        );
        return { status: 200, body: describeKnowledge(configuration) };
      },
    },
    {
      method: 'POST',
      path: '/v1/bot/knowledge/entries',
      handle: async (context) => {
        const body = await context.body();
        const entry = await asClient(context, 'tenant.configuration.write', 'bot.knowledge', (tx) =>
          createKnowledgeEntry(tx, body),
        );
        return { status: 201, body: { entry: describeKnowledgeEntry(entry) } };
      },
    },
    {
      // PUT because an edit replaces the entry's whole text.
      method: 'PUT',
      path: '/v1/bot/knowledge/entries/entry',
      handle: async (context) => {
        const body = await context.body();
        const entry = await asClient(context, 'tenant.configuration.write', 'bot.knowledge', (tx) =>
          updateKnowledgeEntry(tx, body),
        );
        return { status: 200, body: { entry: describeKnowledgeEntry(entry) } };
      },
    },
    {
      // POST rather than DELETE-with-a-body, which intermediaries may drop.
      method: 'POST',
      path: '/v1/bot/knowledge/entries/entry/delete',
      handle: async (context) => {
        const body = await context.body();
        await asClient(context, 'tenant.configuration.write', 'bot.knowledge', (tx) => deleteKnowledgeEntry(tx, body));
        return { status: 204 };
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
    // Reply preview — behavior-rules-configuration.md AC16. A sample message
    // through the live reply path (`previewReply` → `generateReply`), so the
    // preview obeys exactly what a real conversation would. The configuration is
    // read in the tenant's transaction; the model is called after it commits, so
    // a slow provider holds no database connection.
    // -----------------------------------------------------------------------
    {
      method: 'POST',
      path: '/v1/bot/preview',
      handle: async (context) => {
        const message = parsePreviewInput(await context.body());
        const { tenantId, configuration, fallback } = await asClient(
          context,
          'tenant.configuration.read',
          'bot.preview',
          async (tx, principal) => {
            const decision = previewLimiter.take(principal.tenantId);
            if (!decision.allowed) {
              throw new HttpError(429, 'request.rate_limited', {
                'retry-after': String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
              });
            }
            return {
              tenantId: principal.tenantId,
              configuration: await readReplyConfiguration(tx),
              fallback: await readFallbackMessages(tx),
            };
          },
        );
        const outcome = await previewReply(ai, configuration, fallback, message);
        if (outcome.failure !== undefined) {
          logger.warn('api.preview.generation_failed', {
            tenantId,
            errorKind: outcome.failure.kind,
            errorCode: outcome.failure.code,
            retryable: outcome.failure.retryable,
          });
        }
        return { status: 200, body: { preview: outcome.preview } };
      },
    },

    // -----------------------------------------------------------------------
    // Disclosure — bot-disclosure-setting.md. A never-chosen bot reads as the
    // platform default, with `source` saying so.
    // -----------------------------------------------------------------------
    {
      method: 'GET',
      path: '/v1/bot/disclosure',
      handle: async (context) => {
        const setting = await asClient(context, 'tenant.configuration.read', 'bot.disclosure', (tx) =>
          readDisclosureSetting(tx),
        );
        return { status: 200, body: describeDisclosureSetting(setting) };
      },
    },
    {
      method: 'PUT',
      path: '/v1/bot/disclosure',
      handle: async (context) => {
        const body = await context.body();
        const setting = await asClient(context, 'tenant.configuration.write', 'bot.disclosure', (tx) =>
          saveDisclosureSetting(tx, body),
        );
        return { status: 200, body: describeDisclosureSetting(setting) };
      },
    },

    // -----------------------------------------------------------------------
    // Human handoff — human-handoff.md. Configuration only: whether a given
    // conversation is paused is conversation state, and no route here touches it.
    // -----------------------------------------------------------------------
    {
      method: 'GET',
      path: '/v1/bot/handoff',
      handle: async (context) => {
        const settings = await asClient(context, 'tenant.configuration.read', 'bot.handoff', (tx) =>
          readHandoffSettings(tx),
        );
        return { status: 200, body: describeHandoffSettings(settings) };
      },
    },
    {
      // PUT because a save replaces the whole configuration.
      method: 'PUT',
      path: '/v1/bot/handoff',
      handle: async (context) => {
        const body = await context.body();
        const settings = await asClient(context, 'tenant.configuration.write', 'bot.handoff', (tx) =>
          saveHandoffSettings(tx, body),
        );
        return { status: 200, body: describeHandoffSettings(settings) };
      },
    },
    {
      // PUT `{ "enabled": true | false }`: switches handoff on or off and keeps
      // the configured triggers, so the form need not resubmit them.
      method: 'PUT',
      path: '/v1/bot/handoff/enabled',
      handle: async (context) => {
        const body = await context.body();
        const settings = await asClient(context, 'tenant.configuration.write', 'bot.handoff', (tx) =>
          setHandoffEnabled(tx, body),
        );
        return { status: 200, body: describeHandoffSettings(settings) };
      },
    },

    // -----------------------------------------------------------------------
    // Conversation handoff state — human-handoff.md AC9. The pause itself is set
    // by the conversation worker when a turn's answer is a handoff; resuming is
    // the client's. The end-customer is named in the body (the router has no
    // path parameters), and the tenant only by the session, like every route.
    // -----------------------------------------------------------------------
    {
      method: 'POST',
      path: '/v1/conversations/handoff/resume',
      handle: async (context) => {
        const customerId = parseResumeInput(await context.body());
        const status = await asClient(context, 'handoff.manage', 'conversation.handoff', (tx) =>
          resumeConversation(tx, customerId),
        );
        return { status: 200, body: describeConversationHandoff(status) };
      },
    },

    // -----------------------------------------------------------------------
    // Reading conversations — client-conversation-visibility.md. POST, because the
    // filter and the end-customer are phone numbers and a URL is written to every
    // proxy's access log; the resource label names the kind of thing read and never
    // which customer, because access records reach the operator.
    // -----------------------------------------------------------------------
    {
      method: 'POST',
      path: '/v1/conversations/list',
      handle: async (context) => {
        const query = parseConversationListInput(await context.body());
        const page = await asClient(context, 'conversation.read', 'conversation.list', (tx) => listConversations(tx, query));
        return {
          status: 200,
          body: { conversations: page.conversations.map(describeConversationSummary), nextCursor: page.nextCursor ?? null },
        };
      },
    },
    {
      method: 'POST',
      path: '/v1/conversations/transcript',
      handle: async (context) => {
        const query = parseTranscriptInput(await context.body());
        const page = await asClient(context, 'conversation.read', 'conversation.transcript', (tx) => readTranscript(tx, query));
        return { status: 200, body: describeTranscript(page) };
      },
    },

    // -----------------------------------------------------------------------
    // Readiness and the go-live toggle — bot-activation-control.md. The rules
    // (what "ready" is, that an active bot must stay ready) live in the database
    // and @zeddev/bot; these routes only read them and carry the client's toggle.
    // Both answer with the whole status, which also says whether the optional-but-
    // recommended business knowledge is configured — beside the readiness
    // conditions, never among them (business-knowledge-configuration.md AC9, AC10).
    // -----------------------------------------------------------------------
    {
      method: 'GET',
      path: '/v1/bot/status',
      handle: async (context) => {
        const body = await asClient(context, 'tenant.configuration.read', 'bot.status', async (tx) =>
          statusBody(tx, await readBotStatus(tx)),
        );
        return { status: 200, body };
      },
    },
    {
      // PUT `{ "active": true | false }`: the desired state, not a toggle, so a
      // retried request cannot flip the bot back.
      method: 'PUT',
      path: '/v1/bot/activation',
      handle: async (context) => {
        const active = parseActivationInput(await context.body());
        const body = await asClient(context, 'tenant.activation.change', 'bot.activation', async (tx) =>
          statusBody(tx, await setBotActive(tx, active)),
        );
        return { status: 200, body };
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
    // WhatsApp connection — whatsapp-number-connection.md's self-service flow.
    //
    // Three routes, matching the three things a client actually does: submit the
    // number and token, ask for the code, and disconnect. Replying with the code
    // is the fourth step and deliberately has no route — it arrives at the
    // gateway, because a reply that came back through this API would prove
    // nothing about whether WhatsApp can reach the platform.
    // -----------------------------------------------------------------------
    {
      method: 'GET',
      path: '/v1/whatsapp/connection',
      handle: async (context) => {
        const body = await asClient(context, 'tenant.configuration.read', 'whatsapp.connection', async (tx) => {
          // A read is the only moment the answer matters, so it is also where a
          // verification that ran out of time is judged — see
          // `expireStaleVerification`. The client's intent is still to read their
          // connection; the bookkeeping is the platform's, not a write they asked
          // for.
          const status = await expireStaleVerification(tx);
          return {
            ...describeConnection(status, await connectionHistory(tx)),
            setup: describeConnectionSetup(status, await readConnectedNumber(tx), await readVerification(tx)),
          };
        });
        return { status: 200, body };
      },
    },
    {
      method: 'POST',
      path: '/v1/whatsapp/connection',
      handle: async (context) => {
        const body = await asClient(
          context,
          'whatsapp.connection.manage',
          'whatsapp.connection',
          async (tx, principal) => {
            const payload = await context.body();
            const submission = parseCredentialSubmission(payload);
            const replace = payload['replace'] === true;
            const status = await submitCredentials(tx, sealer, submission, {
              principal: principal.accountId,
              replace,
            });
            return {
              ...describeConnection(status, await connectionHistory(tx)),
              setup: describeConnectionSetup(status, await readConnectedNumber(tx), await readVerification(tx)),
            };
          },
        );
        return { status: 200, body };
      },
    },
    {
      method: 'POST',
      path: '/v1/whatsapp/connection/verification',
      handle: async (context) => {
        const code = generateVerificationCode();
        const expiresAt = new Date(clock.now().getTime() + verificationTtlMs);

        // Phase one: the credentials to call Meta with, and the attempt that will
        // record the outcome. Committed before the call, so a send that succeeds
        // and then loses the process still leaves the client an attempt they can
        // see — the reverse order optimises for the case that never produces a
        // support ticket.
        const opened = await asClient(
          context,
          'whatsapp.connection.manage',
          'whatsapp.connection',
          async (tx, principal) => {
            const { recipient } = parseVerificationRequest(await context.body());
            const credentials = await loadCloudCredentials(tx, sealer, { principal: principal.accountId });
            const attempt = await beginVerification(tx, { recipient, code, expiresAt });
            return { credentials, attempt, recipient };
          },
        );

        // Phase two: Meta. Outside any transaction, for the reason the worker
        // never calls a model inside one — a network round trip must not hold a
        // database connection or a row lock.
        const probe = await probeAndSend(opened.credentials, opened.recipient, code);

        // Phase three: what happened. A second authorization is the price of not
        // holding a transaction open across phase two, and it is recorded as a
        // second action, which is an accurate description of what took place.
        const body = await asClient(
          context,
          'whatsapp.connection.manage',
          'whatsapp.connection',
          async (tx) => {
            // Narrowed here rather than inline: `transient` is a classification,
            // not a connection state, so it can never be an error reason.
            const failureReason = probe.sent ? undefined : probe.reason;
            const recoverable =
              failureReason === undefined ||
              failureReason === 'transient' ||
              CLOUD_RECOVERABLE_REASONS.has(failureReason);
            if (probe.sent) {
              await recordVerificationSent(tx, opened.attempt.id, {
                outboundMessageId: probe.outboundMessageId,
                displayNumber: probe.displayNumber,
                verifiedName: probe.verifiedName,
              });
            } else {
              await abandonVerification(tx, opened.attempt.id, 'send_failed', {
                // A recoverable failure leaves the connection in `connecting`: a
                // rate limit or a Meta hiccup is no reason to make the client
                // re-enter credentials that were never wrong.
                errorReason: recoverable ? undefined : failureReason,
              });
            }
            const status = await readConnection(tx);
            return {
              ...describeConnection(status, await connectionHistory(tx)),
              setup: describeConnectionSetup(status, await readConnectedNumber(tx), await readVerification(tx)),
              attempt: probe.sent
                ? { sent: true, recipient: opened.recipient, expiresAt: expiresAt.toISOString() }
                : { sent: false, reason: probe.reason, description: probe.description },
            };
          },
        );
        return { status: 200, body };
      },
    },
    {
      method: 'POST',
      path: '/v1/whatsapp/connection/disconnect',
      handle: async (context) => {
        const body = await asClient(
          context,
          'whatsapp.connection.manage',
          'whatsapp.connection',
          async (tx, principal) => {
            const status = await disconnectNumber(tx, { principal: principal.accountId });
            return {
              ...describeConnection(status, await connectionHistory(tx)),
              setup: describeConnectionSetup(status, await readConnectedNumber(tx), await readVerification(tx)),
            };
          },
        );
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
    {
      // Which provider and model is answering every tenant — ai-provider-
      // portability.md AC8 — and which, if any, waits in the candidate slot. The
      // descriptors carry no credential and no endpoint.
      method: 'GET',
      path: '/v1/operator/ai-provider',
      handle: async (context) => {
        const body = await identity.withOperatorAction(
          sessionToken(context, OPERATOR_SESSION_COOKIE),
          'platform.health.read',
          'ai.provider',
          async () => ({ provider: ai.descriptor, candidate: candidateAi?.descriptor ?? null }),
        );
        return { status: 200, body };
      },
    },
    {
      // ai-provider-portability.md AC4: put the active or the candidate provider
      // through the verification suite, which drives the live reply and media
      // paths with a made-up business. Shares the preview's per-key budget under
      // a key no tenant id can equal, since both spend the one AI quota. The
      // model is called after the operator's transaction commits.
      method: 'POST',
      path: '/v1/operator/ai-provider/verify',
      handle: async (context) => {
        const target = parseVerificationInput(await context.body());
        const provider = await identity.withOperatorAction(
          sessionToken(context, OPERATOR_SESSION_COOKIE),
          'platform.ai.verify',
          'ai.provider',
          async () => {
            const chosen = target === 'active' ? ai : candidateAi;
            if (chosen === undefined) throw new HttpError(409, 'ai.no_candidate');
            const decision = previewLimiter.take('platform:ai-verification');
            if (!decision.allowed) {
              throw new HttpError(429, 'request.rate_limited', {
                'retry-after': String(Math.max(1, Math.ceil(decision.retryAfterMs / 1000))),
              });
            }
            return chosen;
          },
        );
        const verification = await verifyAiProvider(provider, { active: ai.descriptor, clock });
        logger.info(`api.ai_verification.${target}`, {
          count: verification.checks.filter((check) => check.outcome === 'failed').length,
        });
        return { status: 200, body: { target, verification } };
      },
    },

    // -----------------------------------------------------------------------
    // Watching every tenant — operator-health-monitoring.md. Connection states and
    // counts only: what these routes read has no column that could hold a message.
    // POST where a query has options, since the router matches exact paths.
    // -----------------------------------------------------------------------
    {
      // The cheap read a dashboard polls so a state change shows up on its own (AC2).
      method: 'GET',
      path: '/v1/operator/connections',
      handle: async (context) => {
        const tenants = await identity.withOperatorAction(
          sessionToken(context, OPERATOR_SESSION_COOKIE),
          'platform.health.read',
          'connection.health',
          (tx) => listConnectionHealth(tx),
        );
        return { status: 200, body: { tenants } };
      },
    },
    {
      // component-independence.md AC9: which component is down, not just that
      // something is. Each process reports itself (`startHeartbeat`), including the
      // worker and the scheduler, which no probe can reach. Polled by the dashboard
      // with the connections route.
      method: 'GET',
      path: '/v1/operator/components',
      handle: async (context) => {
        const body = await identity.withOperatorAction(
          sessionToken(context, OPERATOR_SESSION_COOKIE),
          'platform.health.read',
          'component.status',
          (tx) => readComponentStatus(tx),
        );
        return { status: 200, body };
      },
    },
    {
      method: 'POST',
      path: '/v1/operator/tenants/health',
      handle: async (context) => {
        const query = parseTenantHealthInput(await context.body());
        const body = await identity.withOperatorAction(
          sessionToken(context, OPERATOR_SESSION_COOKIE),
          'platform.metrics.read',
          'tenant.health.list',
          (tx) => listTenantHealth(tx, query, clock.now()),
        );
        return { status: 200, body };
      },
    },
    {
      method: 'POST',
      path: '/v1/operator/tenants/detail',
      handle: async (context) => {
        const { tenantId, selection } = parseTenantDetailInput(await context.body());
        const body = await identity.withOperatorAction(
          sessionToken(context, OPERATOR_SESSION_COOKIE),
          'platform.metrics.read',
          'tenant.health.detail',
          (tx) => readTenantHealth(tx, tenantId, selection, clock.now()),
        );
        return { status: 200, body };
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

/** A conversation's handoff state as the client's screen shows it. */
