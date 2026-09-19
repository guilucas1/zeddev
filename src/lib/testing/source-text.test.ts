/**
 * Source files contain text, never raw control characters.
 *
 * A literal NUL or BEL inside a string (usually a test fixture for control-
 * character validation) makes git and grep classify the whole file as binary:
 * `git diff` prints "Binary files differ" and a search silently skips it. The
 * file still runs, so the damage goes unnoticed until someone reviews a change
 * to it and sees nothing. Write the character as an escape (`\u0000`, `\u0007`)
 * instead — the string's value is the same.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { REPO_ROOT, unitTest } from './index.ts';

/** C0 controls other than tab, line feed, and carriage return, plus DEL. */
const RAW_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

async function textFiles(): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(ts|sql|sh|json|md|yaml)$/.test(entry.name)) found.push(full);
    }
  }
  await walk(join(REPO_ROOT, 'src'));
  await walk(join(REPO_ROOT, 'scripts'));
  return found;
}

unitTest('no source file contains a raw control character', async () => {
  const violations: string[] = [];
  for (const file of await textFiles()) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (RAW_CONTROL.test(line)) violations.push(`  ${relative(REPO_ROOT, file)}:${index + 1}`);
      });
  }
  assert.deepEqual(
    violations,
    [],
    `Raw control characters make git treat a file as binary; write them as \\u escapes:\n${violations.join('\n')}`,
  );
});
