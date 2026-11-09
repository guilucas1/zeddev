/**
 * Which screen answers each page, and what surrounds it.
 *
 * Kept apart from `shell.ts` so it needs no DOM: the contract test walks this table
 * and proves every page renders against the real API.
 */

import { accountScreen, disclosureScreen, fallbackScreen, handoffScreen, knowledgeScreen, personaScreen, previewScreen, rulesScreen } from './client-bot-screens.ts';
import { connectionScreen, statusScreen } from './client-setup-screens.ts';
import { conversationsScreen } from './conversations-screen.ts';
import { html, type Html } from './html.ts';
import { operatorAccountScreen, operatorDashboardScreen } from './operator-screens.ts';
import type { PageArea, PagePath } from './paths.ts';
import { forgotPasswordScreen, loginScreen, operatorLoginScreen, resetPasswordScreen, signupScreen, verifyEmailScreen } from './public-screens.ts';
import type { ScreenFactory } from './screen.ts';

export const SCREENS: Readonly<Record<PagePath, ScreenFactory>> = {
  '/login': loginScreen,
  '/signup': signupScreen,
  '/verify-email': verifyEmailScreen,
  '/forgot-password': forgotPasswordScreen,
  '/reset-password': resetPasswordScreen,
  '/operator/login': operatorLoginScreen,
  '/': statusScreen,
  '/whatsapp': connectionScreen,
  '/persona': personaScreen,
  '/rules': rulesScreen,
  '/knowledge': knowledgeScreen,
  '/fallback': fallbackScreen,
  '/disclosure': disclosureScreen,
  '/handoff': handoffScreen,
  '/preview': previewScreen,
  '/conversations': conversationsScreen,
  '/account': (context) => accountScreen(context),
  '/operator': operatorDashboardScreen,
  '/operator/account': operatorAccountScreen,
};

/** Each protected area: the probe that says a session exists, and where to go without one. */
export const AREA_SESSIONS: Readonly<Record<Exclude<PageArea, 'public'>, { readonly probe: string; readonly signIn: string; readonly signOut: string }>> = {
  client: { probe: '/v1/session', signIn: '/login', signOut: '/v1/session' },
  operator: { probe: '/v1/operator/session', signIn: '/operator/login', signOut: '/v1/operator/session' },
};

const CLIENT_NAV: readonly (readonly [string, string])[] = [
  ['/', 'Overview'],
  ['/conversations', 'Conversations'],
  ['/whatsapp', 'WhatsApp'],
  ['/persona', 'Persona'],
  ['/rules', 'Rules'],
  ['/knowledge', 'Knowledge'],
  ['/fallback', 'Fallback'],
  ['/disclosure', 'Disclosure'],
  ['/handoff', 'Handoff'],
  ['/preview', 'Try it out'],
  ['/account', 'Account'],
];

const OPERATOR_NAV: readonly (readonly [string, string])[] = [
  ['/operator', 'Platform health'],
  ['/operator/account', 'Account'],
];

/** The frame around a signed-in page. The banner lives outside it, so a re-render cannot erase a confirmation. */
export function frame(area: Exclude<PageArea, 'public'>, path: string, content: Html): Html {
  const nav = area === 'client' ? CLIENT_NAV : OPERATOR_NAV;
  return html`<div class="layout">
    <nav aria-label="Main">
      <p class="brand">Zeddev${area === 'operator' && html` <span class="hint">Operator</span>`}</p>
      <ul>
        ${nav.map(([target, label]) => html`<li><a href="${target}" data-nav ${target === path && html`aria-current="page"`}>${label}</a></li>`)}
      </ul>
      <button class="link" data-signout>Sign out</button>
    </nav>
    <main>${content}</main>
  </div>`;
}

export function notFoundView(): Html {
  return html`<main class="public"><section class="card">
    <p class="brand">Zeddev</p>
    <h1>Page not found</h1>
    <p><a class="button" href="/" data-nav>Go to your dashboard</a></p>
  </section></main>`;
}

export function failedToLoadView(messages: readonly string[]): Html {
  return html`<div class="errors shown">${messages.map((message) => html`<p>${message}</p>`)}</div>
    <p><button data-reload>Try again</button></p>`;
}
