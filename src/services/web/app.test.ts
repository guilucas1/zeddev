/**
 * The dashboard service as an HTTP server, and the safety properties of its markup.
 *
 * What is asserted here is what a browser depends on and cannot check for itself:
 * that a page is allowed to run only this origin's code, that what the browser
 * receives as a module really is JavaScript, and that the forward to the API
 * changes nothing a session or the per-source throttle relies on.
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe } from 'node:test';
import { Logger, MemorySink } from '@zeddev/logging';
import { REPO_ROOT, specTest, unitTest } from '@zeddev/testing';
import { createWeb, PAGE_CSP } from './app.ts';
import { loadAssets } from './assets.ts';
import { loadWebSettings } from './config.ts';
import { startWeb } from './start.ts';
import { Api, ApiError } from './ui/api.ts';
import { escapeText, html } from './ui/html.ts';
import { PAGES } from './ui/paths.ts';
import { SCREENS } from './ui/routes.ts';
import { failureMessages, type ScreenContext } from './ui/screen.ts';
import { verifyEmailScreen } from './ui/public-screens.ts';

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ url: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

interface Seen {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

describe('the dashboard service', () => {
  let upstream: { url: string; server: Server };
  let web: { url: string; server: Server };
  const seen: Seen[] = [];
  const sink = new MemorySink();

  before(async () => {
    upstream = await listen((request, response) => {
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => (body += chunk));
      request.on('end', () => {
        seen.push({ method: request.method, url: request.url, headers: request.headers, body });
        if (request.url === '/v1/hang') return;
        response.writeHead(201, {
          'content-type': 'application/json',
          'set-cookie': ['zd_session=abc; Path=/; HttpOnly', 'other=1; Path=/'],
          'x-request-id': 'from-api',
        });
        response.end('{"ok":true}');
      });
    });
    const settings = { ...loadWebSettings({ WEB_API_UPSTREAM: upstream.url, WEB_UPSTREAM_TIMEOUT: '2s' }), upstreamTimeoutMs: 150 };
    web = await listen(createWeb({ settings, assets: loadAssets(), logger: new Logger({ sink }) }).handler);
  });

  after(async () => {
    await close(web.server);
    await close(upstream.server);
  });

  unitTest('every page address serves the shell document with a policy that forbids inline and foreign script', async () => {
    for (const path of Object.keys(PAGES)) {
      const response = await fetch(`${web.url}${path}`);
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type')!, /^text\/html/);
      assert.equal(response.headers.get('content-security-policy'), PAGE_CSP);
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.match(await response.text(), /<div id="root">/);
    }
    assert.doesNotMatch(PAGE_CSP, /unsafe/);
    assert.match(PAGE_CSP, /script-src 'self'/);
  });

  unitTest('an unknown address is a 404, still with a page to navigate from', async () => {
    const response = await fetch(`${web.url}/no-such-page`);
    assert.equal(response.status, 404);
    assert.match(await response.text(), /<div id="root">/);
  });

  unitTest('the browser modules arrive as JavaScript with their types removed, and the tests stay home', async () => {
    const response = await fetch(`${web.url}/assets/api.ts`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type')!, /^text\/javascript/);
    const body = await response.text();
    assert.doesNotMatch(body, /interface ApiIssue|: Promise<T>/);
    assert.equal((await fetch(`${web.url}/assets/../app.ts`)).status, 404, 'the assets are a table; a path cannot walk out of it');
    assert.equal((await fetch(`${web.url}/assets/%2e%2e/config.ts`)).status, 404);
  });

  unitTest('a test file beside the browser modules is never served', () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeddev-web-assets-'));
    try {
      mkdirSync(join(dir, 'public'));
      mkdirSync(join(dir, 'ui'));
      writeFileSync(join(dir, 'public', 'index.html'), '<!doctype html>');
      writeFileSync(join(dir, 'ui', 'a.ts'), 'export const a: number = 1;');
      writeFileSync(join(dir, 'ui', 'a.test.ts'), 'export const b: number = 2;');
      assert.deepEqual([...loadAssets(dir).files.keys()], ['/assets/a.ts']);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  unitTest('every module the browser loads can be resolved by a browser', () => {
    const uiDir = join(REPO_ROOT, 'src', 'services', 'web', 'ui');
    for (const name of readdirSync(uiDir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
      const source = readFileSync(join(uiDir, name), 'utf8');
      for (const match of source.matchAll(/^import (?!type )[\s\S]*?from '([^']+)'/gm)) {
        assert.match(match[1]!, /^\.\/[a-z-]+\.ts$/, `${name} imports ${match[1]}, which exists only for Node`);
      }
    }
  });

  unitTest('every page has a screen, and every screen a page', () => {
    assert.deepEqual(Object.keys(SCREENS).sort(), Object.keys(PAGES).sort());
  });

  unitTest('a stored asset is revalidated, not downloaded again', async () => {
    const first = await fetch(`${web.url}/assets/styles.css`);
    const etag = first.headers.get('etag')!;
    assert.equal(first.headers.get('cache-control'), 'no-cache');
    const second = await fetch(`${web.url}/assets/styles.css`, { headers: { 'if-none-match': etag } });
    assert.equal(second.status, 304);
  });

  unitTest('a request under /v1/ reaches the API unchanged, and its answer returns unchanged', async () => {
    seen.length = 0;
    const response = await fetch(`${web.url}/v1/session?x=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'zd_session=tok', origin: 'https://example.com' },
      body: '{"email":"a"}',
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { ok: true });
    assert.deepEqual(response.headers.getSetCookie(), ['zd_session=abc; Path=/; HttpOnly', 'other=1; Path=/']);
    assert.equal(response.headers.get('x-request-id'), 'from-api');
    const request = seen.at(-1)!;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/session?x=1');
    assert.equal(request.body, '{"email":"a"}');
    assert.equal(request.headers.cookie, 'zd_session=tok');
    assert.equal(request.headers.origin, 'https://example.com', 'the API makes its cross-origin decision on the original header');
  });

  unitTest('this hop appends its own observation of the caller, and never erases what came before', async () => {
    seen.length = 0;
    await fetch(`${web.url}/v1/x`);
    assert.equal(seen.at(-1)!.headers['x-forwarded-for'], '127.0.0.1');
    await fetch(`${web.url}/v1/x`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
    assert.equal(seen.at(-1)!.headers['x-forwarded-for'], '203.0.113.9, 127.0.0.1');
  });

  unitTest('connection-scoped headers are not forwarded', async () => {
    seen.length = 0;
    // `fetch` refuses to send these, so this one goes by hand.
    await new Promise<void>((resolve, reject) => {
      const sent = httpRequest(`${web.url}/v1/x`, { headers: { 'keep-alive': 'timeout=5', te: 'trailers' } }, (answer) => {
        answer.resume();
        answer.on('end', resolve);
      });
      sent.on('error', reject);
      sent.end();
    });
    assert.equal(seen.at(-1)!.headers['keep-alive'], undefined);
    assert.equal(seen.at(-1)!.headers.te, undefined);
  });

  unitTest('an API that does not answer in time is reported in the API\'s own error shape', async () => {
    const response = await fetch(`${web.url}/v1/hang`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '5');
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    assert.equal(body.error.code, 'service.unavailable');
    assert.ok(body.error.requestId.length > 0);
  });

  specTest(
    'component-independence.md',
    'the dashboard keeps serving while the API is down',
    'with no API listening, pages still load and a forwarded request says the service is unavailable',
    async () => {
      const dead = await listen(() => undefined);
      await close(dead.server);
      const settings = loadWebSettings({ WEB_API_UPSTREAM: dead.url });
      const lonely = await listen(createWeb({ settings, assets: loadAssets(), logger: new Logger({ sink }) }).handler);
      try {
        assert.equal((await fetch(`${lonely.url}/login`)).status, 200);
        assert.equal((await fetch(`${lonely.url}/health/ready`)).status, 200);
        const response = await fetch(`${lonely.url}/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(response.status, 503);
        const answer = new Api((path, init) => fetch(`${lonely.url}${path}`, init)).get('/v1/session');
        // Named, so the dashboard can tell the API being down from the API's own
        // 503 for an unreachable database (component-independence.md AC9).
        await assert.rejects(answer, (error: ApiError) => {
          assert.equal(error.code, 'service.unavailable');
          assert.equal(error.component, 'api');
          assert.match(failureMessages(error)[0]!, /the API service is not answering/);
          return true;
        });
      } finally {
        await close(lonely.server);
      }
    },
  );

  unitTest('an unavailable dependency the API names is named on screen, and an unknown one falls back', () => {
    const database = new ApiError(503, 'service.unavailable', { component: 'database' });
    assert.deepEqual(failureMessages(database), ['The platform is unavailable right now: the database cannot be reached. Please try again in a moment.']);
    const unknown = new ApiError(503, 'service.unavailable', { component: 'flux-capacitor' });
    assert.deepEqual(failureMessages(unknown), ['The platform is unavailable right now. Please try again in a moment.']);
  });

  unitTest('nothing about a caller or a path is logged when the forward fails', () => {
    for (const record of sink.records) {
      if (record.event === 'web.upstream.failed') assert.equal((record.fields as Record<string, unknown>).route, '/v1/');
    }
  });

  unitTest('a page cannot be posted to, only the API can', async () => {
    const response = await fetch(`${web.url}/login`, { method: 'POST', body: 'x' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  });
});

describe('configuration', () => {
  unitTest('the upstream is required, and a missing one is named', () => {
    assert.throws(() => loadWebSettings({}), /WEB_API_UPSTREAM/);
  });

  unitTest('an upstream with a path is refused rather than having it silently dropped', () => {
    assert.throws(() => loadWebSettings({ WEB_API_UPSTREAM: 'http://example.com/api' }), /WEB_API_UPSTREAM/);
  });

  unitTest('the service starts on its own configuration and stops cleanly', async () => {
    const running = await startWeb({ WEB_API_UPSTREAM: 'http://example.com:1', WEB_HTTP_PORT: '0', WEB_HTTP_HOST: '127.0.0.1' }, { sink: new MemorySink() });
    assert.equal((await fetch(`${running.url}/health/live`)).status, 200);
    await running.stop();
    await running.stop();
  });
});

describe('markup', () => {
  unitTest('interpolated text cannot become markup', () => {
    const hostile = `<img src=x onerror="alert('1')">`;
    const made = html`<p title="${hostile}">${hostile}</p>`.text;
    assert.ok(!made.includes('<img'));
    assert.ok(!made.includes('"alert'));
    assert.equal(made, `<p title="${escapeText(hostile)}">${escapeText(hostile)}</p>`);
  });

  unitTest('nested markup and lists compose, and false and null render as nothing', () => {
    assert.equal(html`<a>${[html`<b>${'&'}</b>`, 'x', false, null]}</a>`.text, '<a><b>&amp;</b>x</a>');
  });

  unitTest('no screen makes markup from a string', () => {
    const uiDir = join(REPO_ROOT, 'src', 'services', 'web', 'ui');
    for (const name of readdirSync(uiDir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'html.ts') continue;
      assert.doesNotMatch(readFileSync(join(uiDir, name), 'utf8'), /new Html\(/, `${name} bypasses escaping`);
    }
  });
});

describe('failures', () => {
  specTest(
    'persona-and-tone-configuration.md',
    'AC3 a rejected save identifies the field',
    'every validation issue the API reports is named in words',
    () => {
      const messages = failureMessages(
        new ApiError(400, 'validation.failed', {
          issues: [
            { key: 'botName', reason: 'is required' },
            { key: 'triggerMessages.ai_error', reason: 'is too long' },
          ],
        }),
      );
      assert.deepEqual(messages, ['Bot name is required.', 'Trigger messages ai error is too long.']);
    },
  );

  unitTest('a throttled caller is told how long to wait', () => {
    assert.match(failureMessages(new ApiError(429, 'request.rate_limited', { retryAfterSeconds: 120 }))[0]!, /2 minute/);
  });

  specTest(
    'client-signup-and-tenancy.md',
    'AC7 a provisioning failure shows an error state',
    'the confirmation page reports the failure, grants nothing, and can retry the same link',
    async () => {
      let attempts = 0;
      const api = new Api(async () => {
        attempts += 1;
        const failing = attempts === 1;
        return {
          status: failing ? 500 : 200,
          ok: !failing,
          headers: { get: () => null },
          text: async () => (failing ? '{"error":{"code":"signup.provisioning_failed"}}' : '{"status":"verified"}'),
        };
      });
      const context: ScreenContext = { api, navigate: () => undefined, fragment: () => 'token=abc', clearFragment: () => undefined };
      const screen = verifyEmailScreen(context);
      await screen.load!();
      assert.match(screen.view().text, /Nothing was created/);
      assert.match(screen.view().text, /data-action="retry"/);
      await screen.actions!.retry!({});
      assert.match(screen.view().text, /Your email is confirmed/);
    },
  );
});
