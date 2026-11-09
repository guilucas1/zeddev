/**
 * A client's conversations, and the transcript of any one of them.
 *
 * Which conversation is open is held in this closure and never in the address: a
 * customer's phone number does not belong in a URL. Every piece of customer text
 * reaches the page through `html`, which escapes it.
 *
 * A bot entry shows its delivery state because an answer that was written but
 * never delivered must not look like one the customer received.
 */

import { handoffReason, type HandoffSignal } from './client-bot-screens.ts';
import { html, type Html } from './html.ts';
import { errorSlot, field, isChecked, pill, rethrowIfSignedOut, text, when, type FormValues, type Screen, type ScreenContext } from './screen.ts';

interface ConversationSummary {
  readonly customerId: string;
  readonly paused: boolean;
  readonly pausedAt: string | null;
  readonly reason: HandoffSignal | null;
  readonly lastActivityAt: string;
}

interface ConversationList {
  readonly conversations: readonly ConversationSummary[];
  readonly nextCursor: string | null;
}

type Understanding =
  | { readonly status: 'understood'; readonly text: string }
  | { readonly status: 'failed'; readonly failure: string }
  | { readonly status: 'not_examined' };

type CustomerEntry = {
  readonly from: 'customer';
  readonly id: string;
  readonly at: string;
  readonly heldReason: 'bot_inactive' | 'handoff_paused' | null;
} & (
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly caption: string | null; readonly understanding: Understanding }
  | { readonly type: 'audio'; readonly voice: boolean; readonly understanding: Understanding }
  | { readonly type: 'unsupported'; readonly upstreamType: string }
);

interface BotEntry {
  readonly from: 'bot';
  readonly id: string;
  readonly at: string;
  readonly kind: 'reply' | 'fallback';
  readonly text: string;
  readonly fallbackTrigger: string | null;
  readonly delivery: { readonly state: string; readonly failure: string | null };
}

type Entry = CustomerEntry | BotEntry;

interface Transcript {
  readonly customerId: string;
  readonly paused: boolean;
  readonly pausedAt: string | null;
  readonly reason: HandoffSignal | null;
  readonly handoffHistory: readonly { readonly event: 'paused' | 'resumed'; readonly reason: HandoffSignal | null; readonly occurredAt: string }[];
  readonly entries: readonly Entry[];
  readonly earlierCursor: string | null;
  readonly laterCursor: string | null;
}

/** Often enough that a reply appears while the client watches, without a client left on this page costing much. */
const TRANSCRIPT_POLL_MS = 8_000;

const HELD_REASONS: Readonly<Record<string, string>> = {
  bot_inactive: 'Not answered: the bot was off',
  handoff_paused: 'Not answered: this conversation is with you',
};

const DELIVERY: Readonly<Record<string, Html>> = {
  pending: pill('Sending', 'muted'),
  sending: pill('Sending', 'muted'),
  sent: pill('Delivered to WhatsApp', 'good'),
  failed: pill('Not delivered', 'bad'),
  expired: pill('Not sent: 24-hour window closed', 'bad'),
};

const FALLBACK_LABELS: Readonly<Record<string, string>> = {
  ai_error: 'the AI service failed',
  low_confidence: "the bot wasn't sure",
  out_of_scope: 'the question was out of scope',
};

function understandingView(understanding: Understanding, noun: string): Html {
  switch (understanding.status) {
    case 'understood':
      return html`<div class="prewrap">${understanding.text}</div>`;
    case 'failed':
      return html`<p class="hint">The bot couldn't understand this ${noun}.</p>`;
    case 'not_examined':
      return html`<p class="hint">The bot hasn't looked at this ${noun}.</p>`;
  }
}

function customerBody(entry: CustomerEntry): Html {
  switch (entry.type) {
    case 'text':
      return html`<div class="prewrap">${entry.text}</div>`;
    case 'image':
      return html`<span class="label">Photo</span>
        ${entry.caption !== null && html`<div class="prewrap">${entry.caption}</div>`}
        ${understandingView(entry.understanding, 'photo')}`;
    case 'audio':
      return html`<span class="label">${entry.voice ? 'Voice message' : 'Audio'}</span> ${understandingView(entry.understanding, 'audio')}`;
    case 'unsupported':
      return html`<p class="hint">A ${entry.upstreamType} message, which the bot can't read.</p>`;
  }
}

function entryView(entry: Entry): Html {
  if (entry.from === 'customer') {
    return html`<li class="bubble customer">
      <span class="who">Customer</span>
      ${customerBody(entry)}
      <span class="hint">${when(entry.at)}</span>
      ${entry.heldReason !== null && html`<span class="hint">${HELD_REASONS[entry.heldReason]}</span>`}
    </li>`;
  }
  return html`<li class="bubble bot">
    <span class="who">Bot${entry.kind === 'fallback' && ' (fallback message)'}</span>
    <div class="prewrap">${entry.text}</div>
    <span class="hint">${when(entry.at)}</span>
    ${entry.fallbackTrigger !== null && html`<span class="hint">Sent because ${FALLBACK_LABELS[entry.fallbackTrigger] ?? entry.fallbackTrigger}</span>`}
    ${DELIVERY[entry.delivery.state] ?? pill(entry.delivery.state, 'muted')}
  </li>`;
}

export function conversationsScreen(context: ScreenContext): Screen {
  let filters: { readonly customer: string; readonly activeSince: string; readonly pausedOnly: boolean } = { customer: '', activeSince: '', pausedOnly: false };
  let conversations: readonly ConversationSummary[] = [];
  let nextCursor: string | null = null;
  let open: Transcript | undefined;
  let entries: readonly Entry[] = [];
  let earlierCursor: string | null = null;

  const query = (): Record<string, unknown> => ({
    ...(filters.customer.trim() === '' ? {} : { customer: filters.customer }),
    // A date input gives a day. The API needs an instant, and "since this day" means its start.
    ...(filters.activeSince === '' ? {} : { activeSince: new Date(`${filters.activeSince}T00:00:00`).toISOString() }),
    ...(filters.pausedOnly ? { pausedOnly: true } : {}),
  });

  const loadList = async (): Promise<void> => {
    const answer = await context.api.post<ConversationList>('/v1/conversations/list', query());
    conversations = answer.conversations;
    nextCursor = answer.nextCursor;
  };

  const openConversation = async (customerId: string): Promise<void> => {
    const transcript = await context.api.post<Transcript>('/v1/conversations/transcript', { customerId });
    open = transcript;
    entries = transcript.entries;
    earlierCursor = transcript.earlierCursor;
  };

  /**
   * The latest page, merged over what is held. Asking only for newer entries would
   * miss the change that matters most on a bot entry already showing: its delivery.
   */
  const refreshOpen = async (): Promise<void> => {
    if (open === undefined) return;
    const customerId = open.customerId;
    const latest = await context.api.post<Transcript>('/v1/conversations/transcript', { customerId });
    if (open?.customerId !== customerId) return;
    const latestIds = new Set(latest.entries.map((entry) => entry.id));
    entries = [...entries.filter((entry) => !latestIds.has(entry.id)), ...latest.entries];
    open = latest;
  };

  const listView = (): Html => html`<h1>Conversations</h1>
    <section class="card">
      <form data-form="filter" class="filters">
        ${field({ name: 'customer', label: 'Customer number', value: filters.customer, placeholder: 'Part of a number' })}
        ${field({ name: 'activeSince', label: 'Active since', type: 'date', value: filters.activeSince })}
        <label class="choice"><input type="checkbox" name="pausedOnly" ${filters.pausedOnly && html`checked`} /> <span>Waiting for you only</span></label>
        ${errorSlot}
        <button class="primary">Search</button>
      </form>
    </section>
    <section class="card">
      ${conversations.length === 0
        ? html`<p class="empty">No conversations to show.</p>`
        : html`<ul class="items">
            ${conversations.map(
              (conversation) => html`<li class="item">
                <div>
                  <button class="link" data-action="open" data-customer="${conversation.customerId}">+${conversation.customerId}</button>
                  ${conversation.paused && html`<div class="hint">${handoffReason(conversation.reason)}</div>`}
                </div>
                <div class="row">
                  ${conversation.paused ? pill('Waiting for you', 'warn') : pill('Bot handling', 'good')}
                  <span class="hint">${when(conversation.lastActivityAt)}</span>
                </div>
              </li>`,
            )}
          </ul>
          ${nextCursor !== null && html`<button data-action="more">Show more</button>`}`}
    </section>`;

  const transcriptView = (transcript: Transcript): Html => html`<p><button class="link" data-action="close">← All conversations</button></p>
    <h1>+${transcript.customerId}</h1>
    <section class="card">
      <div class="stats">
        <div><span class="label">Status</span> ${transcript.paused ? pill('Paused for handoff', 'warn') : pill('Bot handling', 'good')}</div>
        ${transcript.paused && html`<div><span class="label">Since</span> ${when(transcript.pausedAt)}</div>`}
        ${transcript.paused && html`<div><span class="label">Why</span> ${handoffReason(transcript.reason)}</div>`}
      </div>
      ${transcript.paused && html`<div class="row"><button class="primary" data-action="resume" data-confirm="Hand this conversation back to the bot?">Resume the bot</button></div>`}
      ${transcript.handoffHistory.length > 0 &&
      html`<h2>Handoff history</h2>
        <ul class="timeline">
          ${transcript.handoffHistory.map(
            (event) => html`<li>
              <strong>${event.event === 'paused' ? 'Handed off' : 'Resumed'}</strong>
              ${event.reason !== null && html` ${handoffReason(event.reason)}`}
              <span class="hint">${when(event.occurredAt)}</span>
            </li>`,
          )}
        </ul>`}
    </section>
    <section class="card">
      ${earlierCursor !== null && html`<p><button data-action="earlier">Show earlier messages</button></p>`}
      <ul class="transcript">${entries.map(entryView)}</ul>
    </section>`;

  return {
    title: 'Conversations',
    load: loadList,
    pollAfterMs: () => (open === undefined ? undefined : TRANSCRIPT_POLL_MS),
    poll: async () => {
      try {
        await refreshOpen();
      } catch (error) {
        rethrowIfSignedOut(error);
      }
    },
    view: () => (open === undefined ? listView() : transcriptView(open)),
    forms: {
      filter: async (values: FormValues) => {
        filters = { customer: text(values, 'customer'), activeSince: text(values, 'activeSince'), pausedOnly: isChecked(values, 'pausedOnly') };
        await loadList();
      },
    },
    actions: {
      open: async ({ customer }) => {
        await openConversation(customer ?? '');
      },
      close: async () => {
        open = undefined;
        entries = [];
        await loadList();
      },
      more: async () => {
        const answer = await context.api.post<ConversationList>('/v1/conversations/list', { ...query(), cursor: nextCursor });
        conversations = [...conversations, ...answer.conversations];
        nextCursor = answer.nextCursor;
      },
      earlier: async () => {
        if (open === undefined) return;
        const page = await context.api.post<Transcript>('/v1/conversations/transcript', { customerId: open.customerId, before: earlierCursor });
        entries = [...page.entries, ...entries];
        earlierCursor = page.earlierCursor;
      },
      resume: async () => {
        if (open === undefined) return undefined;
        await context.api.post('/v1/conversations/handoff/resume', { customerId: open.customerId });
        await openConversation(open.customerId);
        return 'The bot is handling this conversation again.';
      },
    },
  };
}
