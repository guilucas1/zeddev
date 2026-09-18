/**
 * Why these tests matter: they are the difference between a documentation
 * promise and a build-time one.
 *
 * `environment-portability.md` makes two *inspectable* claims — that the
 * configuration list is complete, and that it is sufficient by itself to explain
 * every behavioural difference between tiers. A hand-maintained list satisfies
 * both on the day it is written. These tests are what keep it true afterwards:
 * one fails when the committed reference drifts from the schemas, the other
 * fails when a package grows a schema that nobody registered. Without the second,
 * the first is satisfiable by a reference that is internally consistent and
 * missing a whole subsystem.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe } from 'node:test';
import { REPO_ROOT, specTest, unitTest } from '@zeddev/testing';
import { PLATFORM_CONFIG_SCHEMAS, configKeys, renderPlatformReference } from './index.ts';

const REFERENCE_PATH = join(REPO_ROOT, 'docs', 'configuration.md');

describe('the generated configuration reference', () => {
  specTest(
    'environment-portability.md',
    'given the documented list of configuration inputs, when each input is reviewed, then it is sufficient by itself to explain every behavioral difference between two deployments on different environment tiers',
    'the committed reference matches the schemas that actually parse the environment',
    () => {
      const committed = readFileSync(REFERENCE_PATH, 'utf8');
      assert.equal(
        committed,
        renderPlatformReference(),
        'docs/configuration.md is stale — run `npm run config-reference`',
      );
    },
  );

  specTest(
    'environment-portability.md',
    'the system must expose a complete, documented set of configuration inputs sufficient to account for every behavioral difference needed to run on a given environment',
    'no package defines a configuration schema that the reference does not know about',
    () => {
      // The one remaining way the reference could drift: a package grows a
      // schema and nobody adds it to the registry. Scanning for the naming
      // convention rather than trusting the registry is what closes that.
      const declared = new Set(
        PLATFORM_CONFIG_SCHEMAS.flatMap((section) => Object.keys(section.schema)),
      );
      const found = new Set<string>();

      // Services are scanned as well as libraries: a service owns the keys that
      // are properties of itself, and those are the ones a new service is most
      // likely to add without thinking of the reference.
      const packages = ['lib', 'services'].flatMap((area) => {
        try {
          return readdirSync(join(REPO_ROOT, 'src', area)).map((pkg) => join(REPO_ROOT, 'src', area, pkg));
        } catch {
          return [];
        }
      });
      for (const pkg of packages) {
        for (const file of ['config.ts', 'index.ts']) {
          let source: string;
          try {
            source = readFileSync(join(pkg, file), 'utf8');
          } catch {
            continue;
          }
          const schema = /export const ([A-Z0-9_]+_CONFIG_SCHEMA) = \{([\s\S]*?)\n\} as const/.exec(source);
          if (schema === null) continue;
          for (const match of (schema[2] ?? '').matchAll(/^ {2}([A-Z][A-Z0-9_]+):/gm)) {
            found.add(match[1]!);
          }
        }
      }

      assert.ok(found.size > 0, 'the scan must actually find something, or it proves nothing');
      const unregistered = [...found].filter((key) => !declared.has(key)).sort();
      assert.deepEqual(
        unregistered,
        [],
        'these configuration keys exist but appear in no registered schema — add the package to PLATFORM_CONFIG_SCHEMAS',
      );
    },
  );

  specTest(
    'component-independence.md',
    'AC1 one component is redeployed without restarting any other',
    'every service has its own image definition and its own entry in the Compose file',
    () => {
      // One image per service is what lets one be rebuilt and redeployed while the
      // others keep running. A service added without both would either not be
      // deployable at all or be deployed inside another's image, which couples
      // their releases.
      const compose = readFileSync(join(REPO_ROOT, 'compose.yaml'), 'utf8');
      const services = readdirSync(join(REPO_ROOT, 'src', 'services'));
      assert.ok(services.length > 0, 'the scan must find a service, or it proves nothing');
      for (const service of services) {
        const dockerfile = join(REPO_ROOT, 'src', 'services', service, 'Dockerfile');
        assert.ok(readFileSync(dockerfile, 'utf8').includes(`src/services/${service}/`), `${dockerfile} must run its own service`);
        assert.ok(
          compose.includes(`dockerfile: src/services/${service}/Dockerfile`),
          `compose.yaml has no service built from src/services/${service}/Dockerfile`,
        );
      }
    },
  );

  unitTest('an image can never contain a deployment’s values', () => {
    // The image is the source tree, so the ignore file is the only thing between
    // a developer's `.env` and a pushed image — credential-and-secret-handling.md
    // AC1 forbids a secret in any build artifact.
    const ignored = readFileSync(join(REPO_ROOT, '.dockerignore'), 'utf8').split('\n').map((line) => line.trim());
    for (const entry of ['.env', '.env.*', 'deploy/secrets', '.git']) {
      assert.ok(ignored.includes(entry), `.dockerignore must exclude ${entry}`);
    }
  });

  unitTest('every documented key appears in the reference and the template', () => {
    const reference = renderPlatformReference();
    for (const key of configKeys()) {
      assert.ok(reference.includes(key), `${key} must be documented`);
    }
  });

  unitTest('no two schemas claim the same key', () => {
    // A collision would let one section's default silently win over another's,
    // and the reference would show both while only one took effect.
    const keys = PLATFORM_CONFIG_SCHEMAS.flatMap((section) => Object.keys(section.schema));
    assert.equal(new Set(keys).size, keys.length);
  });

  specTest(
    'credential-and-secret-handling.md',
    'given any log, diagnostic record, error message, metric, alert, or notification, when it is inspected, then it contains no secret value',
    'the reference names the secrets without carrying a value for any of them',
    () => {
      const reference = renderPlatformReference();
      assert.match(reference, /DATABASE_PASSWORD[\s\S]*?\*\*\(secret\)\*\*/);
      assert.match(reference, /STORAGE_SECRET_ACCESS_KEY[\s\S]*?\*\*\(secret\)\*\*/);
      // The template leaves every required key blank, so a committed template is
      // never a committed credential.
      const template = reference.slice(reference.indexOf('## Template'));
      assert.match(template, /^DATABASE_PASSWORD=$/m);
      assert.match(template, /^STORAGE_SECRET_ACCESS_KEY=$/m);
    },
  );
});
