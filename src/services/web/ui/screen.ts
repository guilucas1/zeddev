/**
 * What a screen is, and the pieces every screen shares.
 *
 * A screen holds its state in a closure and is driven from outside: `load`, then
 * `view`, then a handler per form or button. It never touches the DOM. That is
 * what lets `contract.test.ts` run every screen against the real API with nothing
 * but `fetch`, and it leaves `shell.ts` as the only code needing a browser.
 */

import { ApiError, type Api } from './api.ts';
import { html, type Child, type Html } from './html.ts';

export type FormValues = Readonly<Record<string, string | readonly string[] | undefined>>;

/** A handler's answer: an optional confirmation for the banner. */
export type Outcome = string | undefined | void;

export interface Screen {
  readonly title: string;
  load?(): Promise<void>;
  view(): Html;
  /** Keyed by a form's `data-form`. A throw leaves the form as typed and shows why. */
  readonly forms?: Readonly<Record<string, (values: FormValues) => Promise<Outcome>>>;
  /** Keyed by a button's `data-action`; receives that element's `data-*` values. */
  readonly actions?: Readonly<Record<string, (data: Readonly<Record<string, string | undefined>>) => Promise<Outcome> | Outcome>>;
  /** How long until the next `poll`. Undefined means do not poll right now. */
  pollAfterMs?(): number | undefined;
  poll?(): Promise<void>;
}

export interface ScreenContext {
  readonly api: Api;
  /** Go to a page. The notice is shown there. */
  navigate(path: string, notice?: string): void;
  /** The current address's fragment, without the `#`. */
  readonly fragment: () => string;
  /** Remove the fragment, so a token does not stay in the address bar or history. */
  clearFragment(): void;
}

export type ScreenFactory = (context: ScreenContext) => Screen;

export function text(values: FormValues, name: string): string {
  const value = values[name];
  return typeof value === 'string' ? value : (value?.[0] ?? '');
}

export function list(values: FormValues, name: string): readonly string[] {
  const value = values[name];
  if (value === undefined) return [];
  return typeof value === 'string' ? [value] : value;
}

export function isChecked(values: FormValues, name: string): boolean {
  return values[name] !== undefined;
}

/** `botName` → "Bot name", `triggerMessages.ai_error` → "Trigger messages ai error". */
function humanize(key: string): string {
  const words = key
    .replace(/\[(\d+)\]/g, ' $1')
    .replace(/[._]/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const CODE_MESSAGES: Readonly<Record<string, string>> = {
  'ai.no_candidate': 'No candidate AI provider is configured. Set the AI_CANDIDATE_* keys and restart the API to verify one.',
  'auth.forbidden': "You don't have access to that.",
  'network': "We couldn't reach the server. Check your connection and try again.",
  'request.cross_origin': 'This page was not opened from the address the platform is configured for.',
  'request.too_large': 'That is too much text to send at once.',
  'resource.not_found': 'That no longer exists. It may have been removed already.',
  'service.unavailable': 'The platform is unavailable right now. Please try again in a moment.',
  'signup.provisioning_failed': "We couldn't finish setting up your workspace. Nothing was created. Please try again.",
};

/** A sentence for a failure. Every validation issue is named, because the API reports all of them at once. */
export function failureMessages(error: unknown): readonly string[] {
  if (!(error instanceof ApiError)) return ['Something went wrong. Please try again.'];
  if (error.issues.length > 0) return error.issues.map((issue) => `${humanize(issue.key)} ${issue.reason}.`);
  if (error.detail !== undefined) return [error.detail];
  if (error.code === 'request.rate_limited') {
    return [
      error.retryAfterSeconds === undefined
        ? 'Too many attempts. Please wait a little and try again.'
        : `Too many attempts. Please wait about ${Math.ceil(error.retryAfterSeconds / 60)} minute(s) and try again.`,
    ];
  }
  return [CODE_MESSAGES[error.code] ?? 'Something went wrong. Please try again.'];
}

export function failureView(error: unknown): Html {
  return html`<ul>${failureMessages(error).map((message) => html`<li>${message}</li>`)}</ul>`;
}

// Parts used across screens ------------------------------------------------------

export function when(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return '—';
  return new Date(iso).toLocaleString();
}

/** Where a form's failure is shown. `shell.ts` fills it; it is empty until then. */
export const errorSlot: Html = html`<div class="errors" data-role="errors" role="alert"></div>`;

export interface FieldOptions {
  readonly name: string;
  readonly label: string;
  readonly value?: string | null | undefined;
  readonly type?: string;
  readonly hint?: Child;
  readonly required?: boolean;
  readonly autocomplete?: string;
  readonly placeholder?: string;
}

export function field(options: FieldOptions): Html {
  return html`<label class="field">
    <span class="label">${options.label}</span>
    <input
      name="${options.name}"
      type="${options.type ?? 'text'}"
      value="${options.value ?? ''}"
      ${options.required === true && html`required`}
      ${options.autocomplete !== undefined && html`autocomplete="${options.autocomplete}"`}
      ${options.placeholder !== undefined && html`placeholder="${options.placeholder}"`}
    />
    ${options.hint !== undefined && html`<span class="hint">${options.hint}</span>`}
  </label>`;
}

export function textArea(options: FieldOptions & { readonly rows?: number }): Html {
  return html`<label class="field">
    <span class="label">${options.label}</span>
    <textarea name="${options.name}" rows="${options.rows ?? 4}" ${options.required === true && html`required`}>${options.value ?? ''}</textarea>
    ${options.hint !== undefined && html`<span class="hint">${options.hint}</span>`}
  </label>`;
}

export function pill(label: string, tone: 'good' | 'warn' | 'bad' | 'muted'): Html {
  return html`<span class="pill ${tone}">${label}</span>`;
}

const CONNECTION_TONES: Readonly<Record<string, 'good' | 'warn' | 'bad' | 'muted'>> = {
  connected: 'good',
  connecting: 'warn',
  reconnecting: 'warn',
  error: 'bad',
  disconnected: 'muted',
};

export function connectionPill(state: string): Html {
  return pill(state.charAt(0).toUpperCase() + state.slice(1), CONNECTION_TONES[state] ?? 'muted');
}

/** A poll failure must not disturb what is on screen, except that it may be stale, and a lost session is not stale. */
export function rethrowIfSignedOut(error: unknown): void {
  if (error instanceof ApiError && error.code === 'auth.failed') throw error;
}
