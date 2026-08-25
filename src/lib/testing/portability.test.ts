/**
 * Executable enforcement of `environment-portability.md`'s inspectable criteria.
 *
 * The spec states two requirements as things an inspector would look for:
 *
 *   - AC5: "Given the system's source code, when it is inspected for
 *     environment-detection branching (e.g. 'if environment == X'), then no such
 *     branching affecting functional behavior is found."
 *   - The requirement that every environment-specific value — external addresses,
 *     credentials, resource limits, storage locations — be an externally supplied
 *     configuration input, "never a value embedded in the code."
 *
 * A criterion phrased as an inspection is a criterion nobody performs. Encoding it
 * as a test means the guarantee is checked on every run rather than during a
 * review that eventually stops happening.
 *
 * This is deliberately built now, while `src/` is small. The mitigation is nearly
 * free today; once a few thousand lines exist, the first run produces a backlog
 * of violations and gets skipped instead of fixed.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { specTest, REPO_ROOT } from './index.ts';

const SRC_DIR = join(REPO_ROOT, 'src');

async function sourceFiles(): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        found.push(full);
      }
    }
  }
  await walk(SRC_DIR);
  return found;
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly rule: string;
}

/**
 * Remove a trailing `//` comment, but only when the `//` is outside a string.
 *
 * A naive `/\/\/.*$/` strip is actively harmful here: it truncates
 * `'postgres://localhost/db'` at the `//`, so the embedded-address rule silently
 * stops matching the exact literal it exists to catch. A guard with a false
 * negative is worse than no guard, because it is trusted.
 */
function stripComment(line: string): string {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]!;
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && line[i + 1] === '/') return line.slice(0, i);
  }
  return line;
}

async function scan(rules: readonly { name: string; pattern: RegExp }[]): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of await sourceFiles()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, index) => {
      // Comments describe the rules; they are not the behavior the rules govern.
      const withoutComment = stripComment(text).replace(/^\s*\*.*$/, '');
      for (const rule of rules) {
        if (rule.pattern.test(withoutComment)) {
          violations.push({
            file: relative(REPO_ROOT, file),
            line: index + 1,
            text: text.trim(),
            rule: rule.name,
          });
        }
      }
    });
  }
  return violations;
}

function report(violations: readonly Violation[]): string {
  return violations.map((v) => `  ${v.file}:${v.line} [${v.rule}] ${v.text}`).join('\n');
}

specTest(
  'environment-portability.md',
  'AC5 no environment-detection branching',
  'no source file branches on which environment tier it is running in',
  async () => {
    const violations = await scan([
      // The canonical form. Its mere presence is the violation: reading NODE_ENV
      // at all means behavior can differ between tiers for reasons the documented
      // config list cannot explain (AC6).
      { name: 'NODE_ENV', pattern: /\bNODE_ENV\b/ },
      { name: 'environment comparison', pattern: /===?\s*['"](production|development|staging|local|prod|dev|test)['"]/ },
      { name: 'environment predicate', pattern: /\b(isProduction|isDevelopment|isStaging|isLocal|isProd|isDev)\b/ },
      { name: 'tier detection', pattern: /\bprocess\.env\s*\.\s*(ENV|ENVIRONMENT|APP_ENV|DEPLOY_ENV|STAGE|TIER)\b/ },
    ]);

    assert.deepEqual(
      violations,
      [],
      `Environment-tier branching found. Differences between tiers must be configuration\n` +
        `values, never code paths (environment-portability.md AC5):\n${report(violations)}`,
    );
  },
);

specTest(
  'environment-portability.md',
  'environment-specific values are configuration inputs, not embedded',
  'no source file embeds a hostname, port, or endpoint that differs between tiers',
  async () => {
    const violations = await scan([
      { name: 'embedded localhost', pattern: /['"`][a-z]+:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)/i },
      { name: 'embedded private address', pattern: /['"`](?:https?|postgres(?:ql)?|redis|amqp):\/\/\d+\.\d+\.\d+\.\d+/ },
      // A literal API endpoint pins the deployment to one upstream and cannot be
      // pointed at a sandbox or a mock without a code change.
      { name: 'embedded external endpoint', pattern: /['"`]https?:\/\/(?!example\.(com|org)\b)[a-z0-9.-]+\.[a-z]{2,}/i },
    ]);

    assert.deepEqual(
      violations,
      [],
      `Environment-specific values must be supplied as configuration, never embedded\n` +
        `in code (environment-portability.md):\n${report(violations)}`,
    );
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC1 no secret embedded in source or build artifact',
  'no source file contains a credential-shaped literal',
  async () => {
    const violations = await scan([
      // Meta/WhatsApp access tokens.
      { name: 'WhatsApp access token', pattern: /['"`]EAA[A-Za-z0-9]{20,}/ },
      // GitHub tokens — the repo's own .env has held one, so this is not theoretical.
      { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/ },
      { name: 'Google API key', pattern: /\bAIza[A-Za-z0-9_-]{30,}/ },
      { name: 'AWS access key id', pattern: /\bAKIA[A-Z0-9]{16}\b/ },
      { name: 'private key block', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
      // An assignment of a literal to a secret-named identifier.
      {
        name: 'hard-coded credential assignment',
        pattern: /\b(apiKey|api_key|accessToken|access_token|clientSecret|client_secret|password|passwd)\s*[:=]\s*['"`][^'"`\s]{8,}['"`]/i,
      },
    ]);

    assert.deepEqual(
      violations,
      [],
      `Credentials must come from configuration, never from source\n` +
        `(credential-and-secret-handling.md AC1):\n${report(violations)}`,
    );
  },
);
