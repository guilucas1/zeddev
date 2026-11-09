/**
 * The screens a person sees before they have a session.
 *
 * The two link-driven pages read their token from the address's fragment, the one
 * part of a URL a browser never sends to a server (IMPLEMENTATION_PLAN.md §1). They
 * clear it at once so it does not stay in the address bar or the history, and keep
 * it in memory for a retry.
 */

import { ApiError } from './api.ts';
import { html, type Html } from './html.ts';
import { errorSlot, failureMessages, field, text, type Screen, type ScreenContext } from './screen.ts';

function publicCard(heading: string, body: Html): Html {
  return html`<main class="public"><section class="card">
    <p class="brand">Zeddev</p>
    <h1>${heading}</h1>
    ${body}
  </section></main>`;
}

/** Take the token out of the address and return it. */
function takeToken(context: ScreenContext): string | undefined {
  const token = new URLSearchParams(context.fragment()).get('token') ?? undefined;
  context.clearFragment();
  return token === '' ? undefined : token;
}

export function loginScreen(context: ScreenContext): Screen {
  return {
    title: 'Sign in',
    view: () =>
      publicCard(
        'Sign in',
        html`<form data-form="login">
            ${field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' })}
            ${field({ name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' })}
            ${errorSlot}
            <button class="primary">Sign in</button>
          </form>
          <p class="links"><a href="/forgot-password" data-nav>Forgot your password?</a> · <a href="/signup" data-nav>Create an account</a></p>`,
      ),
    forms: {
      login: async (values) => {
        try {
          await context.api.post('/v1/session', { email: text(values, 'email'), password: text(values, 'password') });
        } catch (error) {
          // Deliberately one message for every cause, as the API's answer is.
          if (error instanceof ApiError && error.code === 'auth.failed') {
            throw new ApiError(401, 'auth.failed', {
              detail: "That didn't work. Check your email and password. If you've just signed up, confirm your email address first.",
            });
          }
          throw error;
        }
        context.navigate('/');
      },
    },
  };
}

export function signupScreen(context: ScreenContext): Screen {
  let pendingEmail: string | undefined;
  let resent = false;

  return {
    title: 'Create an account',
    view: () =>
      pendingEmail === undefined
        ? publicCard(
            'Create an account',
            html`<form data-form="signup">
                ${field({ name: 'businessName', label: 'Business name', required: true, autocomplete: 'organization' })}
                ${field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' })}
                ${field({
                  name: 'password',
                  label: 'Password',
                  type: 'password',
                  required: true,
                  autocomplete: 'new-password',
                  hint: 'Use a long passphrase. Common or predictable passwords are refused.',
                })}
                ${errorSlot}
                <button class="primary">Create account</button>
              </form>
              <p class="links"><a href="/login" data-nav>Already have an account? Sign in</a></p>`,
          )
        : publicCard(
            'Check your email',
            html`<p>We sent a confirmation link to <strong>${pendingEmail}</strong>. Open it to finish setting up your workspace.</p>
              ${resent && html`<p class="notice">If that address is waiting for confirmation, a new link is on its way.</p>`}
              <form data-form="resend">${errorSlot}<button>Send the link again</button></form>
              <p class="links"><a href="/login" data-nav>Back to sign in</a></p>`,
          ),
    forms: {
      signup: async (values) => {
        const email = text(values, 'email');
        await context.api.post('/v1/signup', { businessName: text(values, 'businessName'), email, password: text(values, 'password') });
        pendingEmail = email;
      },
      resend: async () => {
        await context.api.post('/v1/email-verification/requests', { email: pendingEmail });
        resent = true;
      },
    },
  };
}

type VerifyState =
  | { readonly kind: 'missing' }
  | { readonly kind: 'verified' }
  | { readonly kind: 'rejected'; readonly reasons: readonly string[] }
  | { readonly kind: 'retryable'; readonly reasons: readonly string[] };

export function verifyEmailScreen(context: ScreenContext): Screen {
  let token: string | undefined;
  let state: VerifyState = { kind: 'missing' };
  let sent = false;

  const redeem = async (): Promise<void> => {
    if (token === undefined) {
      state = { kind: 'missing' };
      return;
    }
    try {
      await context.api.post('/v1/email-verification', { token });
      state = { kind: 'verified' };
    } catch (error) {
      const reasons = failureMessages(error);
      // A provisioning failure or an outage leaves the link good. Only the API
      // rejecting the token itself means this link is finished.
      state = error instanceof ApiError && error.status === 400 ? { kind: 'rejected', reasons } : { kind: 'retryable', reasons };
    }
  };

  const requestNewLink = html`<form data-form="newLink">
    ${field({ name: 'email', label: 'Your email', type: 'email', required: true, autocomplete: 'username' })}
    ${errorSlot}
    <button>Send a new link</button>
  </form>`;

  return {
    title: 'Confirm your email',
    load: async () => {
      token = takeToken(context);
      await redeem();
    },
    view: () => {
      switch (state.kind) {
        case 'verified':
          return publicCard(
            'Your email is confirmed',
            html`<p>Your workspace is ready.</p><p><a class="button primary" href="/login" data-nav>Sign in</a></p>`,
          );
        case 'retryable':
          return publicCard(
            "We couldn't finish",
            html`<div class="errors shown">${state.reasons.map((reason) => html`<p>${reason}</p>`)}</div>
              <button class="primary" data-action="retry">Try again</button>`,
          );
        case 'rejected':
          return publicCard(
            'This link no longer works',
            html`<div class="errors shown">${state.reasons.map((reason) => html`<p>${reason}</p>`)}</div>
              ${sent ? html`<p class="notice">If that address is waiting for confirmation, a new link is on its way.</p>` : requestNewLink}`,
          );
        case 'missing':
          return publicCard(
            'Confirm your email',
            html`<p>Open the link from your confirmation email, or request a new one.</p>
              ${sent ? html`<p class="notice">If that address is waiting for confirmation, a new link is on its way.</p>` : requestNewLink}`,
          );
      }
    },
    actions: { retry: redeem },
    forms: {
      newLink: async (values) => {
        await context.api.post('/v1/email-verification/requests', { email: text(values, 'email') });
        sent = true;
      },
    },
  };
}

export function forgotPasswordScreen(context: ScreenContext): Screen {
  let sent = false;
  return {
    title: 'Reset your password',
    view: () =>
      publicCard(
        'Reset your password',
        html`${sent
            ? html`<p class="notice">If that address has an account, a reset link is on its way. It works once and expires soon.</p>`
            : html`<form data-form="forgot">
                ${field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' })}
                ${errorSlot}
                <button class="primary">Send reset link</button>
              </form>`}
          <p class="links"><a href="/login" data-nav>Back to sign in</a></p>`,
      ),
    forms: {
      forgot: async (values) => {
        await context.api.post('/v1/password-resets/requests', { email: text(values, 'email') });
        sent = true;
      },
    },
  };
}

export function resetPasswordScreen(context: ScreenContext): Screen {
  let token: string | undefined;
  return {
    title: 'Choose a new password',
    load: async () => {
      token = takeToken(context);
    },
    view: () =>
      publicCard(
        'Choose a new password',
        token === undefined
          ? html`<p>This page needs the link from your reset email.</p><p><a class="button" href="/forgot-password" data-nav>Request a new link</a></p>`
          : html`<form data-form="reset">
                ${field({ name: 'newPassword', label: 'New password', type: 'password', required: true, autocomplete: 'new-password' })}
                ${field({ name: 'confirmation', label: 'Repeat it', type: 'password', required: true, autocomplete: 'new-password' })}
                ${errorSlot}
                <button class="primary">Change password</button>
              </form>
              <p class="links"><a href="/forgot-password" data-nav>Request a new link</a></p>`,
      ),
    forms: {
      reset: async (values) => {
        const newPassword = text(values, 'newPassword');
        if (newPassword !== text(values, 'confirmation')) {
          throw new ApiError(400, 'validation.failed', { detail: "Those two passwords don't match." });
        }
        await context.api.post('/v1/password-resets', { token, newPassword });
        context.navigate('/login', 'Your password was changed. Sign in with the new one.');
      },
    },
  };
}

export function operatorLoginScreen(context: ScreenContext): Screen {
  return {
    title: 'Operator sign in',
    view: () =>
      publicCard(
        'Operator sign in',
        html`<form data-form="login">
          ${field({ name: 'email', label: 'Email', type: 'email', required: true, autocomplete: 'username' })}
          ${field({ name: 'password', label: 'Password', type: 'password', required: true, autocomplete: 'current-password' })}
          ${errorSlot}
          <button class="primary">Sign in</button>
        </form>`,
      ),
    forms: {
      login: async (values) => {
        try {
          await context.api.post('/v1/operator/session', { email: text(values, 'email'), password: text(values, 'password') });
        } catch (error) {
          if (error instanceof ApiError && error.code === 'auth.failed') {
            throw new ApiError(401, 'auth.failed', { detail: "That didn't work. Check your email and password." });
          }
          throw error;
        }
        context.navigate('/operator');
      },
    },
  };
}
