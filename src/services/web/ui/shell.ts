/**
 * The browser side: the only code in the dashboard that touches the DOM.
 *
 * Deliberately thin, because it is the part the test runner cannot execute. It
 * routes, renders what a screen returns, and turns clicks and submits into calls on
 * that screen; every decision lives in the screens, which run in `node:test`.
 *
 * A background refresh must never eat what someone is typing, so a poll redraws
 * only when the result differs and no form on the page has been touched.
 */

import { Api, ApiError } from './api.ts';
import { Html, html } from './html.ts';
import { isPagePath, PAGES, type PageArea } from './paths.ts';
import { AREA_SESSIONS, failedToLoadView, frame, notFoundView, SCREENS } from './routes.ts';
import { failureMessages, failureView, type FormValues, type Screen, type ScreenContext } from './screen.ts';

const root = document.getElementById('root')!;

const NOTICE_MS = 6_000;

const api = new Api((path, init) => fetch(path, init));

let screen: Screen | undefined;
let area: PageArea = 'public';
let path = '/';
let notice: string | undefined;
let formTouched = false;
let lastDrawn = '';
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
/** Incremented on every navigation, so work finishing for a page already left is dropped. */
let generation = 0;

const context: ScreenContext = {
  api,
  navigate: (target, message) => void go(target, message),
  fragment: () => location.hash.slice(1),
  clearFragment: () => history.replaceState(null, '', location.pathname),
};

function draw(content: Html): void {
  const page = area === 'public' ? content : frame(area, path, content);
  const banner = html`<div id="banner" role="status" class="${notice === undefined ? '' : 'visible'}">${notice ?? ''}</div>`;
  const markup = banner.text + page.text;
  lastDrawn = markup;
  root.innerHTML = markup;
  formTouched = false;
  if (notice !== undefined) expireNotice();
}

/** A confirmation is about the moment it appeared; left up, it would describe something that is over. */
function expireNotice(): void {
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = undefined;
    document.getElementById('banner')?.classList.remove('visible');
  }, NOTICE_MS);
}

function drawScreen(): void {
  if (screen !== undefined) draw(screen.view());
}

function signedOut(error: unknown): boolean {
  if (area === 'public' || !(error instanceof ApiError) || error.code !== 'auth.failed') return false;
  void go(AREA_SESSIONS[area].signIn, 'Please sign in again.');
  return true;
}

function schedulePoll(owner: number): void {
  clearTimeout(pollTimer);
  const delay = screen?.pollAfterMs?.();
  if (delay === undefined) return;
  pollTimer = setTimeout(() => void runPoll(owner), delay);
}

async function runPoll(owner: number): Promise<void> {
  if (owner !== generation) return;
  // Nobody is looking, so spend nothing; the visibility listener catches up.
  if (!document.hidden && screen?.poll !== undefined) {
    try {
      await screen.poll();
    } catch (error) {
      if (signedOut(error)) return;
    }
    if (owner !== generation) return;
    if (!formTouched && !isEditing()) {
      const next = screen.view();
      const page = area === 'public' ? next : frame(area, path, next);
      if (!lastDrawn.endsWith(page.text)) drawScreen();
    }
  }
  schedulePoll(owner);
}

function isEditing(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement;
}

async function hasSession(probe: string): Promise<boolean> {
  try {
    await api.get(probe);
    return true;
  } catch (error) {
    if (error instanceof ApiError && error.code === 'auth.failed') return false;
    throw error;
  }
}

async function go(target: string, message?: string, push = true): Promise<void> {
  const owner = ++generation;
  clearTimeout(pollTimer);
  if (push && target !== location.pathname) history.pushState(null, '', target);
  notice = message;
  await show(target, owner);
}

async function show(target: string, owner: number): Promise<void> {
  path = target;
  screen = undefined;

  if (!isPagePath(target)) {
    area = 'public';
    document.title = 'Not found · Zeddev';
    draw(notFoundView());
    return;
  }

  area = PAGES[target];
  try {
    if (area !== 'public') {
      const session = AREA_SESSIONS[area];
      const signedIn = await hasSession(session.probe);
      if (owner !== generation) return;
      if (!signedIn) {
        void go(session.signIn, notice);
        return;
      }
    } else if (target === '/login' || target === '/signup' || target === '/operator/login') {
      const session = target === '/operator/login' ? AREA_SESSIONS.operator : AREA_SESSIONS.client;
      const signedIn = await hasSession(session.probe);
      if (owner !== generation) return;
      if (signedIn) {
        void go(target === '/operator/login' ? '/operator' : '/');
        return;
      }
    }

    const candidate = SCREENS[target](context);
    await candidate.load?.();
    if (owner !== generation) return;
    screen = candidate;
    document.title = `${candidate.title} · Zeddev`;
    drawScreen();
    schedulePoll(owner);
  } catch (error) {
    if (owner !== generation || signedOut(error)) return;
    draw(failedToLoadView(failureMessages(error)));
  }
}

function formValues(form: HTMLFormElement, submitter: HTMLElement | null): FormValues {
  const data = submitter === null ? new FormData(form) : new FormData(form, submitter);
  const values: Record<string, string | string[]> = {};
  for (const name of new Set(data.keys())) {
    const all = data.getAll(name).filter((value): value is string => typeof value === 'string');
    values[name] = all.length === 1 ? all[0]! : all;
  }
  return values;
}

function setBusy(element: HTMLElement, busy: boolean): void {
  element.toggleAttribute('data-busy', busy);
  for (const control of element.matches('button') ? [element] : element.querySelectorAll('button')) {
    (control as HTMLButtonElement).disabled = busy;
  }
}

async function submit(form: HTMLFormElement, submitter: HTMLElement | null): Promise<void> {
  const handler = screen?.forms?.[form.dataset.form ?? ''];
  if (handler === undefined) return;
  const owner = generation;
  const errors = form.querySelector<HTMLElement>('[data-role="errors"]');
  errors?.classList.remove('shown');
  if (errors !== null) errors.innerHTML = '';
  // Read before anything is disabled: a disabled button is not a submitter, so
  // the choice between "save" and "preview" would silently disappear.
  const values = formValues(form, submitter);
  setBusy(form, true);
  try {
    const message = await handler(values);
    if (owner !== generation) return;
    notice = message === undefined ? undefined : message;
    drawScreen();
    schedulePoll(owner);
  } catch (error) {
    if (owner !== generation || signedOut(error)) return;
    // The form is left exactly as typed; only the explanation appears.
    setBusy(form, false);
    if (errors !== null) {
      errors.innerHTML = failureView(error).text;
      errors.classList.add('shown');
      errors.scrollIntoView({ block: 'nearest' });
    } else {
      showBanner(failureMessages(error).join(' '));
    }
  }
}

function showBanner(message: string): void {
  notice = message;
  const banner = document.getElementById('banner');
  if (banner !== null) {
    banner.textContent = message;
    banner.classList.add('visible');
  }
  expireNotice();
}

async function runAction(button: HTMLElement): Promise<void> {
  const handler = screen?.actions?.[button.dataset.action ?? ''];
  if (handler === undefined) return;
  if (button.dataset.confirm !== undefined && !window.confirm(button.dataset.confirm)) return;
  const owner = generation;
  setBusy(button, true);
  try {
    const message = await handler({ ...button.dataset });
    if (owner !== generation) return;
    notice = message === undefined ? undefined : message;
    drawScreen();
    schedulePoll(owner);
  } catch (error) {
    if (owner !== generation || signedOut(error)) return;
    setBusy(button, false);
    showBanner(failureMessages(error).join(' '));
  }
}

async function signOut(): Promise<void> {
  if (area === 'public') return;
  const { signOut: route, signIn } = AREA_SESSIONS[area];
  await api.delete(route).catch(() => undefined);
  void go(signIn, 'You are signed out.');
}

root.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const link = target.closest<HTMLAnchorElement>('a[data-nav]');
  if (link !== null) {
    event.preventDefault();
    void go(link.pathname);
    return;
  }
  if (target.closest('[data-signout]') !== null) {
    void signOut();
    return;
  }
  if (target.closest('[data-reload]') !== null) {
    location.reload();
    return;
  }
  const button = target.closest<HTMLElement>('[data-action]');
  if (button !== null) {
    event.preventDefault();
    void runAction(button);
  }
});

root.addEventListener('submit', (event) => {
  event.preventDefault();
  void submit(event.target as HTMLFormElement, (event as SubmitEvent).submitter);
});

root.addEventListener('input', () => {
  formTouched = true;
});

root.addEventListener('change', (event) => {
  const form = (event.target as HTMLElement).closest<HTMLFormElement>('form[data-autosubmit]');
  if (form !== null) void submit(form, null);
});

window.addEventListener('popstate', () => void go(location.pathname, undefined, false));

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && screen?.poll !== undefined) void runPoll(generation);
});

void go(location.pathname, undefined, false);
