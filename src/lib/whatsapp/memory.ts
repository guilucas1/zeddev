/**
 * The scripted backend every fake and stub of the Cloud API shares, and the
 * in-memory adapter built on it.
 *
 * The backend speaks the *port's* vocabulary, not Meta's wire format. That is
 * what makes the conformance suite meaningful: the in-memory adapter calls these
 * methods directly, and the HTTP stub in `stubs.ts` decodes a real Graph request
 * back into them before calling the same methods. When a test asserts "the send
 * carried this text", it is asserting about what arrived, not about what the
 * adapter meant to send.
 *
 * Failures are scripted rather than provoked because none of the conditions the
 * connection spec cares about — a revoked token, an unverified business, a rate
 * limit — can be produced against the real API on demand, and every acceptance
 * criterion about them is otherwise untestable.
 */

import { TransientTransportError } from '@zeddev/errors';
import {
  assertCloudCredentials,
  assertSendableText,
  cloudFailure,
  unreachableContext,
  type BusinessAccountProfile,
  type CloudCredentials,
  type CloudDescriptor,
  type NumberProfile,
  type SentMessage,
  type WhatsAppCloud,
} from './cloud.ts';

/** Every operation on the port, as a value, so failures can be scripted by name. */
export const CLOUD_OPERATIONS = [
  'describeNumber',
  'describeBusinessAccount',
  'subscribeApp',
  'listSubscribedApps',
  'unsubscribeApp',
  'sendText',
] as const;
export type CloudOperation = (typeof CLOUD_OPERATIONS)[number];

/** A Meta failure as the wire would carry it. Rendered verbatim by the stub. */
export interface ScriptedFailure {
  readonly status: number;
  readonly code: number;
  readonly subcode?: number | undefined;
  /**
   * Meta quotes the request back in its error messages. Kept here so the stub can
   * reproduce that, which is what proves the adapters never carry an upstream
   * message into a diagnostic.
   */
  readonly message?: string | undefined;
}

/** An account as Meta would hold it. Everything the port can observe, and nothing else. */
export interface ScriptedAccount {
  readonly token: string;
  readonly phoneNumberId: string;
  readonly businessAccountId: string;
  /** The Meta app the token belongs to — what subscribing registers on the account. */
  readonly appId: string;
  readonly displayNumber?: string | undefined;
  readonly verifiedName?: string | undefined;
  readonly qualityRating?: string | undefined;
  readonly numberVerification?: string | undefined;
  readonly businessName?: string | undefined;
  readonly verificationStatus?: string | undefined;
  readonly reviewStatus?: string | undefined;
}

export interface ObservedSend {
  readonly phoneNumberId: string;
  readonly to: string;
  readonly body: string;
  readonly messageId: string;
}

/** Meta's answer when the token is not one it knows. */
const UNKNOWN_TOKEN: ScriptedFailure = {
  status: 401,
  code: 190,
  message: 'Error validating access token: the session has been invalidated.',
};

/** Meta's answer for an object the token cannot see. */
const UNKNOWN_OBJECT: ScriptedFailure = {
  status: 400,
  code: 100,
  subcode: 33,
  message: 'Unsupported get request. Object does not exist or does not support this operation.',
};

interface AccountState extends ScriptedAccount {
  readonly subscribedApps: Set<string>;
}

export class ScriptedCloudBackend {
  readonly #accounts = new Map<string, AccountState>();
  readonly #failures = new Map<CloudOperation, ScriptedFailure[]>();
  readonly #lost = new Map<CloudOperation, number>();
  readonly sends: ObservedSend[] = [];
  #messageCounter = 0;

  /** Add or replace an account. The token is the key, as it is at Meta. */
  register(account: ScriptedAccount): void {
    this.#accounts.set(account.token, { ...account, subscribedApps: new Set() });
  }

  /** The next call to `operation` fails this way, then normal service resumes. */
  failNext(operation: CloudOperation, failure: ScriptedFailure): void {
    const queued = this.#failures.get(operation) ?? [];
    queued.push(failure);
    this.#failures.set(operation, queued);
  }

  /**
   * The next call to `operation` takes effect, and then its answer is lost.
   *
   * The distinction from `failNext` is the whole point: after `failNext` nothing
   * happened, and after `loseNext` something did. A caller that cannot tell them
   * apart will either duplicate the effect or discard it.
   */
  loseNext(operation: CloudOperation): void {
    this.#lost.set(operation, (this.#lost.get(operation) ?? 0) + 1);
  }

  /** Which app ids an account is currently subscribed to, for assertions. */
  subscribersOf(token: string): readonly string[] {
    return [...(this.#accounts.get(token)?.subscribedApps ?? [])];
  }

  #take(operation: CloudOperation): void {
    const queued = this.#failures.get(operation);
    const next = queued?.shift();
    if (next !== undefined) throw next;
  }

  /** Called *after* the work, so the effect stands and only the answer is gone. */
  #loseAnswer(operation: CloudOperation): void {
    const remaining = this.#lost.get(operation) ?? 0;
    if (remaining === 0) return;
    this.#lost.set(operation, remaining - 1);
    throw ANSWER_LOST;
  }

  #account(token: string): AccountState {
    const account = this.#accounts.get(token);
    if (account === undefined) throw UNKNOWN_TOKEN;
    return account;
  }

  #forNumber(token: string, phoneNumberId: string): AccountState {
    const account = this.#account(token);
    if (account.phoneNumberId !== phoneNumberId) throw UNKNOWN_OBJECT;
    return account;
  }

  #forBusiness(token: string, businessAccountId: string): AccountState {
    const account = this.#account(token);
    if (account.businessAccountId !== businessAccountId) throw UNKNOWN_OBJECT;
    return account;
  }

  describeNumber(token: string, phoneNumberId: string): NumberProfile {
    this.#take('describeNumber');
    const account = this.#forNumber(token, phoneNumberId);
    return {
      phoneNumberId: account.phoneNumberId,
      displayNumber: account.displayNumber ?? '',
      verifiedName: account.verifiedName ?? '',
      qualityRating: account.qualityRating ?? 'unknown',
      numberVerification: account.numberVerification ?? 'verified',
    };
  }

  describeBusinessAccount(token: string, businessAccountId: string): BusinessAccountProfile {
    this.#take('describeBusinessAccount');
    const account = this.#forBusiness(token, businessAccountId);
    return {
      businessAccountId: account.businessAccountId,
      name: account.businessName ?? '',
      verificationStatus: account.verificationStatus ?? 'verified',
      reviewStatus: account.reviewStatus ?? 'approved',
    };
  }

  subscribeApp(token: string, businessAccountId: string): void {
    this.#take('subscribeApp');
    const account = this.#forBusiness(token, businessAccountId);
    account.subscribedApps.add(account.appId);
  }

  listSubscribedApps(token: string, businessAccountId: string): readonly string[] {
    this.#take('listSubscribedApps');
    return [...this.#forBusiness(token, businessAccountId).subscribedApps];
  }

  unsubscribeApp(token: string, businessAccountId: string): void {
    this.#take('unsubscribeApp');
    const account = this.#forBusiness(token, businessAccountId);
    account.subscribedApps.delete(account.appId);
  }

  sendText(token: string, phoneNumberId: string, to: string, body: string): SentMessage {
    this.#take('sendText');
    const account = this.#forNumber(token, phoneNumberId);
    this.#messageCounter += 1;
    const messageId = `wamid.scripted.${this.#messageCounter}`;
    this.sends.push({ phoneNumberId: account.phoneNumberId, to, body, messageId });
    this.#loseAnswer('sendText');
    return { messageId };
  }
}

/**
 * The backend did the work and the answer never came back.
 *
 * Not a `ScriptedFailure`: a scripted failure is something Meta *said*, and this
 * is the case where Meta said nothing. It exists because it is the only way to
 * exercise `message-delivery-reliability.md` AC7's hard half — a send whose
 * outcome cannot be known — and because the two adapters must agree about it.
 */
const ANSWER_LOST = Symbol('whatsapp.cloud.answer_lost');

export function isAnswerLost(value: unknown): boolean {
  return value === ANSWER_LOST;
}

export function isScriptedFailure(value: unknown): value is ScriptedFailure {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['status'] === 'number' && typeof candidate['code'] === 'number';
}

export interface InMemoryWhatsAppCloudOptions {
  readonly appId: string;
  readonly backend?: ScriptedCloudBackend | undefined;
}

/**
 * The fake adapter.
 *
 * It converts a scripted failure with `cloudFailure` — the same function the real
 * adapter uses — so the classification under test is the production one. A fake
 * that invented its own errors would let the two adapters disagree about what a
 * revoked token means, which is the disagreement the conformance suite exists to
 * rule out.
 */
export class InMemoryWhatsAppCloud implements WhatsAppCloud {
  readonly descriptor: CloudDescriptor;
  readonly backend: ScriptedCloudBackend;

  constructor(options: InMemoryWhatsAppCloudOptions) {
    this.backend = options.backend ?? new ScriptedCloudBackend();
    this.descriptor = Object.freeze({ baseUrl: 'memory://whatsapp', appId: options.appId });
  }

  #run<T>(operation: CloudOperation, credentials: CloudCredentials, fn: () => T): T {
    assertCloudCredentials(credentials);
    try {
      return fn();
    } catch (error) {
      if (isAnswerLost(error)) {
        throw new TransientTransportError(`WhatsApp Cloud API ${operation} did not complete.`, {
          code: 'whatsapp.cloud.unreachable',
          context: unreachableContext(operation, 'unknown'),
        });
      }
      if (!isScriptedFailure(error)) throw error;
      throw cloudFailure(operation, { status: error.status, code: error.code, subcode: error.subcode });
    }
  }

  async describeNumber(credentials: CloudCredentials): Promise<NumberProfile> {
    return this.#run('describeNumber', credentials, () =>
      this.backend.describeNumber(credentials.accessToken.expose(), credentials.phoneNumberId),
    );
  }

  async describeBusinessAccount(credentials: CloudCredentials): Promise<BusinessAccountProfile> {
    return this.#run('describeBusinessAccount', credentials, () =>
      this.backend.describeBusinessAccount(credentials.accessToken.expose(), credentials.businessAccountId),
    );
  }

  async subscribeApp(credentials: CloudCredentials): Promise<void> {
    this.#run('subscribeApp', credentials, () =>
      this.backend.subscribeApp(credentials.accessToken.expose(), credentials.businessAccountId),
    );
  }

  async listSubscribedApps(credentials: CloudCredentials): Promise<readonly string[]> {
    return this.#run('listSubscribedApps', credentials, () =>
      this.backend.listSubscribedApps(credentials.accessToken.expose(), credentials.businessAccountId),
    );
  }

  async unsubscribeApp(credentials: CloudCredentials): Promise<void> {
    this.#run('unsubscribeApp', credentials, () =>
      this.backend.unsubscribeApp(credentials.accessToken.expose(), credentials.businessAccountId),
    );
  }

  async sendText(
    credentials: CloudCredentials,
    message: { readonly to: string; readonly body: string },
  ): Promise<SentMessage> {
    assertSendableText(message);
    return this.#run('sendText', credentials, () =>
      this.backend.sendText(credentials.accessToken.expose(), credentials.phoneNumberId, message.to, message.body),
    );
  }
}
