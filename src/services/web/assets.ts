/**
 * What the browser downloads, prepared once at startup.
 *
 * The platform has no build step (IMPLEMENTATION_PLAN.md §1), and a browser cannot
 * run TypeScript, so the dashboard's modules are type-stripped here the same way
 * Node strips them for the services: annotations are blanked and nothing else
 * changes. The browser therefore runs the sources in this image, and `tsc` checks
 * them with the rest of the repository.
 *
 * Every asset is read into a table before the listener opens. A request can only
 * select an entry from that table: no part of a URL ever reaches the filesystem,
 * so there is no path traversal to defend against.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_DIR = dirname(fileURLToPath(import.meta.url));

/** The mount point of every asset. Also how the shell document refers to them. */
export const ASSET_PREFIX = '/assets/';

export interface Asset {
  readonly body: Buffer;
  readonly contentType: string;
  /** A strong validator, so a browser revalidates cheaply and a new release is picked up at once. */
  readonly etag: string;
}

export interface Assets {
  /** The document served for every dashboard page. */
  readonly shell: Asset;
  /** Keyed by full request path. */
  readonly files: ReadonlyMap<string, Asset>;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  // Stripped before serving. The extension stays `.ts` because the modules import
  // each other by their source names, which is what Node and tsc need too.
  ts: 'text/javascript; charset=utf-8',
};

function asset(body: Buffer, extension: string): Asset {
  const contentType = CONTENT_TYPES[extension];
  if (contentType === undefined) throw new Error(`web asset has an unserved type: ${extension}`);
  return { body, contentType, etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 32)}"` };
}

export function loadAssets(serviceDir: string = SERVICE_DIR): Assets {
  const files = new Map<string, Asset>();
  let shell: Asset | undefined;

  const publicDir = join(serviceDir, 'public');
  for (const name of readdirSync(publicDir)) {
    const made = asset(readFileSync(join(publicDir, name)), name.split('.').pop()!);
    if (name === 'index.html') shell = made;
    else files.set(`${ASSET_PREFIX}${name}`, made);
  }

  const uiDir = join(serviceDir, 'ui');
  for (const name of readdirSync(uiDir)) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts')) continue;
    const stripped = stripTypeScriptTypes(readFileSync(join(uiDir, name), 'utf8'), { mode: 'strip' });
    files.set(`${ASSET_PREFIX}${name}`, asset(Buffer.from(stripped, 'utf8'), 'ts'));
  }

  if (shell === undefined) throw new Error('web assets have no public/index.html');
  return { shell, files };
}
