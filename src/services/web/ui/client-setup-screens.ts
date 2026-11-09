/**
 * Where a client business goes live: its status, and its WhatsApp connection.
 *
 * Both screens poll, because what they show changes without the client doing
 * anything: a verification reply arrives over WhatsApp, a link drops and recovers.
 */

import { html, type Html } from './html.ts';
import {
  connectionPill,
  errorSlot,
  field,
  pill,
  rethrowIfSignedOut,
  text,
  when,
  isChecked,
  type Screen,
  type ScreenContext,
} from './screen.ts';

interface BotStatus {
  readonly ready: boolean;
  readonly active: boolean;
  readonly canGoLive: boolean;
  readonly unmetConditions: readonly { readonly condition: string; readonly description: string }[];
  readonly firstReadyAt: string | null;
  readonly activeChangedAt: string | null;
  readonly activeChangeCause: 'client' | 'readiness_lost' | null;
  readonly businessKnowledge: { readonly configured: boolean; readonly required: false; readonly recommendation: string | null };
}

interface ActivationHistory {
  readonly events: readonly { readonly active: boolean; readonly cause: string; readonly occurredAt: string }[];
}

const CONDITION_LINKS: Readonly<Record<string, string>> = { whatsapp_connection: '/whatsapp', persona: '/persona' };

const STATUS_POLL_MS = 30_000;

export function statusScreen(context: ScreenContext): Screen {
  let status: BotStatus;
  let history: ActivationHistory['events'] = [];

  const refresh = async (): Promise<void> => {
    const [nextStatus, nextHistory] = await Promise.all([
      context.api.get<BotStatus>('/v1/bot/status'),
      context.api.get<ActivationHistory>('/v1/bot/activation/history'),
    ]);
    status = nextStatus;
    history = nextHistory.events;
  };

  return {
    title: 'Overview',
    load: refresh,
    pollAfterMs: () => STATUS_POLL_MS,
    poll: async () => {
      try {
        await refresh();
      } catch (error) {
        rethrowIfSignedOut(error);
      }
    },
    view: () => html`<h1>Overview</h1>
      <section class="card">
        <div class="stats">
          <div><span class="label">Readiness</span> ${status.ready ? pill('Ready', 'good') : pill('Not ready', 'warn')}</div>
          <div><span class="label">Bot</span> ${status.active ? pill('On', 'good') : pill('Off', 'muted')}</div>
          <div><span class="label">Since</span> ${when(status.activeChangedAt)}</div>
        </div>
        ${status.activeChangeCause === 'readiness_lost' &&
        !status.active &&
        html`<p class="warning">The bot was switched off automatically because a readiness condition stopped being met.</p>`}
        ${status.unmetConditions.length > 0 &&
        html`<h2>Before you can go live</h2>
          <ul class="checklist">
            ${status.unmetConditions.map(
              (item) => html`<li>
                ${item.description}
                ${CONDITION_LINKS[item.condition] !== undefined && html`<a href="${CONDITION_LINKS[item.condition]}" data-nav>Set this up</a>`}
              </li>`,
            )}
          </ul>`}
        <div class="row">
          ${status.active
            ? html`<button data-action="setActive" data-active="false" data-confirm="Turn the bot off? Customers will stop getting automatic replies.">Turn bot off</button>`
            : html`<button class="primary" data-action="setActive" data-active="true" ${!status.canGoLive && html`disabled`}>Go live</button>`}
        </div>
      </section>

      ${status.businessKnowledge.recommendation !== null &&
      html`<section class="card">
        <h2>Recommended</h2>
        <p>${status.businessKnowledge.recommendation}</p>
        <p><a href="/knowledge" data-nav>Add business knowledge</a> <span class="hint">Optional. Your bot can go live without it.</span></p>
      </section>`}

      <section class="card">
        <h2>On and off history</h2>
        ${history.length === 0
          ? html`<p class="empty">The bot hasn't been switched on or off yet.</p>`
          : html`<ul class="timeline">
              ${history.map(
                (event) => html`<li>
                  <strong>${event.active ? 'Turned on' : 'Turned off'}</strong>
                  ${event.cause === 'readiness_lost' ? ' automatically, readiness lost' : ' by you'}
                  <span class="hint">${when(event.occurredAt)}</span>
                </li>`,
              )}
            </ul>`}
      </section>`,
    actions: {
      setActive: async (data) => {
        status = await context.api.put<BotStatus>('/v1/bot/activation', { active: data.active === 'true' });
        history = (await context.api.get<ActivationHistory>('/v1/bot/activation/history')).events;
        return status.active ? 'Your bot is live.' : 'Your bot is off.';
      },
    },
  };
}

interface Connection {
  readonly state: string;
  readonly error: { readonly reason: string; readonly description: string } | null;
  readonly lastKnownGoodAt: string | null;
  readonly changedAt: string | null;
  readonly history: readonly { readonly from: string; readonly to: string; readonly errorReason: string | null; readonly occurredAt: string }[];
  readonly setup: {
    readonly number: {
      readonly phoneNumberId: string;
      readonly businessAccountId: string;
      readonly displayNumber: string | null;
      readonly verifiedName: string | null;
      readonly credentialConfigured: true;
    } | null;
    readonly verification: {
      readonly recipient: string;
      readonly outcome: 'pending' | 'passed' | 'failed';
      readonly failure: string | null;
      readonly startedAt: string;
      readonly expiresAt: string;
      readonly completedAt: string | null;
    } | null;
    readonly currentStep: 'authorize' | 'submit' | 'send' | 'reply' | null;
    readonly steps: readonly { readonly key: string; readonly title: string; readonly detail: string }[];
  };
}

type Attempt =
  | { readonly sent: true; readonly recipient: string; readonly expiresAt: string }
  | { readonly sent: false; readonly reason: string; readonly description: string };

/** Quick enough that a client who just replied on their phone sees the result before wondering. */
const VERIFICATION_POLL_MS = 4_000;
const CONNECTION_POLL_MS = 30_000;

const VERIFICATION_FAILURES: Readonly<Record<string, string>> = {
  send_failed: "The code couldn't be sent to that number.",
  reply_not_received: 'No reply with the code arrived in time.',
  superseded: 'A newer code replaced this one.',
};

export function connectionScreen(context: ScreenContext): Screen {
  let connection: Connection;
  let attempt: Attempt | undefined;
  let replacing = false;

  const refresh = async (): Promise<void> => {
    connection = await context.api.get<Connection>('/v1/whatsapp/connection');
  };

  const credentialsForm = (replace: boolean): Html => html`<form data-form="credentials">
    ${field({ name: 'phoneNumberId', label: 'Phone number ID', required: true, hint: 'Numbers only, from WhatsApp Manager.' })}
    ${field({ name: 'businessAccountId', label: 'WhatsApp Business Account ID', required: true, hint: 'Numbers only.' })}
    ${field({ name: 'accessToken', label: 'Access token', type: 'password', required: true, autocomplete: 'off', hint: 'Stored encrypted. It is never shown again.' })}
    ${replace && html`<input type="hidden" name="replace" value="on" />`}
    ${errorSlot}
    <div class="row">
      <button class="primary">${replace ? 'Replace number' : 'Save and continue'}</button>
      ${replace && html`<button type="button" data-action="cancelReplace">Cancel</button>`}
    </div>
  </form>`;

  const verificationForm = (): Html => html`<form data-form="verification">
    ${field({
      name: 'recipient',
      label: 'Your own WhatsApp number',
      required: true,
      value: connection.setup.verification?.recipient,
      placeholder: '5511999999999',
      hint: 'International format, digits only. We send a code there, then you reply to it with that code.',
    })}
    ${errorSlot}
    <button class="primary">${connection.setup.currentStep === 'reply' ? 'Send a new code' : 'Send code'}</button>
  </form>`;

  const steps = (): Html => html`<ol class="steps">
    ${connection.setup.steps.map(
      (step) => html`<li class="${step.key === connection.setup.currentStep ? 'current' : ''}">
        <strong>${step.title}</strong>
        <p>${step.detail}</p>
      </li>`,
    )}
  </ol>`;

  const attemptView = (): Html | false => {
    if (attempt === undefined) return false;
    return attempt.sent
      ? html`<p class="notice">Code sent to ${attempt.recipient}. Reply to it on WhatsApp with the code before ${when(attempt.expiresAt)}.</p>`
      : html`<p class="warning">${attempt.description}</p>`;
  };

  const body = (): Html => {
    const { state, setup } = connection;
    if (replacing) return html`<h2>Replace your number</h2><p>The current number stops working as soon as you submit.</p>${credentialsForm(true)}`;
    if (state === 'connected' || state === 'reconnecting') {
      return html`<div class="row">
        <button data-action="startReplace">Replace number</button>
        <button class="danger" data-action="disconnect" data-confirm="Disconnect this number? The bot will stop answering on it.">Disconnect</button>
      </div>`;
    }
    if (state === 'connecting') {
      const verification = setup.verification;
      return html`${steps()}
        ${verification?.outcome === 'pending' && html`<p class="notice">Waiting for your reply on WhatsApp. This page updates by itself.</p>`}
        ${verification?.outcome === 'failed' && verification.failure !== null && html`<p class="warning">${VERIFICATION_FAILURES[verification.failure] ?? verification.failure}</p>`}
        ${attemptView()}
        ${verificationForm()}
        <div class="row"><button data-action="disconnect" data-confirm="Cancel connecting this number?">Start over</button></div>`;
    }
    return html`${steps()}${credentialsForm(false)}`;
  };

  return {
    title: 'WhatsApp',
    load: refresh,
    pollAfterMs: () => (connection.setup.verification?.outcome === 'pending' ? VERIFICATION_POLL_MS : CONNECTION_POLL_MS),
    poll: async () => {
      try {
        await refresh();
      } catch (error) {
        rethrowIfSignedOut(error);
      }
    },
    view: () => {
      const { state, error, setup, history, lastKnownGoodAt } = connection;
      return html`<h1>WhatsApp</h1>
        <section class="card">
          <div class="stats">
            <div><span class="label">Status</span> ${connectionPill(state)}</div>
            <div><span class="label">Last working</span> ${when(lastKnownGoodAt)}</div>
          </div>
          ${error !== null && html`<p class="warning"><strong>${error.reason === 'business_verification_required' ? 'Action needed with Meta. ' : ''}</strong>${error.description}</p>`}
          ${state === 'reconnecting' && html`<p class="notice">The connection dropped. We're retrying automatically.</p>`}
          ${setup.number !== null &&
          html`<dl class="facts">
            ${setup.number.displayNumber !== null && html`<dt>Number</dt><dd>${setup.number.displayNumber}</dd>`}
            ${setup.number.verifiedName !== null && html`<dt>Business name</dt><dd>${setup.number.verifiedName}</dd>`}
            <dt>Phone number ID</dt><dd>${setup.number.phoneNumberId}</dd>
            <dt>Access token</dt><dd>Configured</dd>
          </dl>`}
          ${body()}
        </section>
        <section class="card">
          <h2>History</h2>
          ${history.length === 0
            ? html`<p class="empty">Nothing yet.</p>`
            : html`<ul class="timeline">
                ${history.map(
                  (entry) => html`<li>
                    ${entry.from} → <strong>${entry.to}</strong>
                    ${entry.errorReason !== null && html` (${entry.errorReason})`}
                    <span class="hint">${when(entry.occurredAt)}</span>
                  </li>`,
                )}
              </ul>`}
        </section>`;
    },
    forms: {
      credentials: async (values) => {
        connection = await context.api.post<Connection>('/v1/whatsapp/connection', {
          phoneNumberId: text(values, 'phoneNumberId').trim(),
          businessAccountId: text(values, 'businessAccountId').trim(),
          accessToken: text(values, 'accessToken').trim(),
          ...(isChecked(values, 'replace') ? { replace: true } : {}),
        });
        replacing = false;
        attempt = undefined;
      },
      verification: async (values) => {
        const answer = await context.api.post<Connection & { readonly attempt: Attempt }>('/v1/whatsapp/connection/verification', {
          recipient: text(values, 'recipient').trim(),
        });
        connection = answer;
        attempt = answer.attempt;
      },
    },
    actions: {
      startReplace: () => {
        replacing = true;
      },
      cancelReplace: () => {
        replacing = false;
      },
      disconnect: async () => {
        connection = await context.api.post<Connection>('/v1/whatsapp/connection/disconnect');
        attempt = undefined;
      },
    },
  };
}
