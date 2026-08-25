/**
 * The complete set of configuration inputs, and the reference generated from it.
 *
 * `environment-portability.md` states two requirements that are really one:
 *
 *   - "The system must expose a **complete, documented** set of configuration
 *     inputs sufficient to account for every behavioral difference needed to run
 *     on a given environment."
 *   - "Given the documented list of configuration inputs, when each input is
 *     reviewed, then it is **sufficient by itself** to explain every observed
 *     behavioral difference between two deployments of the system on different
 *     environment tiers."
 *
 * Both are checkable claims about a document, which is exactly the kind of claim
 * that rots. A hand-written environment-variable reference is accurate on the day
 * it is written and wrong by the second key anyone adds, and the failure is
 * silent — the platform still runs, and a laptop deployment still works, and only
 * someone standing up the VPS tier discovers the missing line.
 *
 * So the reference is *generated* from the schemas that actually parse the
 * environment, and `index.test.ts` fails the build when the committed file no
 * longer matches. That turns a documentation promise into a build-time one: a new
 * key cannot be added without the reference gaining a row, because the row is
 * derived from the same object the parser reads.
 *
 * This module is also where a schema becomes *reachable*. A schema that exists
 * but is in no registry is a schema the reference does not know about, so
 * `PLATFORM_CONFIG_SCHEMAS` is the single list, and the test below asserts it
 * covers every `*_CONFIG_SCHEMA` exported anywhere under `src/lib`. Forgetting to
 * register one is the only way this could still drift, and it is closed.
 */

import { renderEnvTemplate, renderReference, type ConfigSchema } from '@zeddev/config';
import { DATABASE_CONFIG_SCHEMA } from '@zeddev/db';
import { STORAGE_CONFIG_SCHEMA } from '@zeddev/storage';

export interface ConfigSection {
  /** Heading in the generated reference. */
  readonly title: string;
  /** Why a deployment needs this group at all, and what changes between tiers. */
  readonly rationale: string;
  readonly schema: ConfigSchema;
}

/**
 * Every configuration schema the platform reads, in the order a reader should
 * meet them.
 *
 * Adding a package with a `*_CONFIG_SCHEMA` means adding it here. The test in
 * `index.test.ts` enforces that, by scanning `src/lib` rather than trusting it.
 */
export const PLATFORM_CONFIG_SCHEMAS: readonly ConfigSection[] = [
  {
    title: 'Database',
    rationale:
      'PostgreSQL carries relational data, the job queue, and — later — vector embeddings, so it is the one backing service every tier must supply. Discrete keys rather than a connection URL, so that exactly one of them is a secret and cannot be serialised by accident. The role named here must not be a superuser and must not carry BYPASSRLS: both are exempt from every row-level security policy in the schema, which would silently remove all tenant isolation while appearing to work.',
    schema: DATABASE_CONFIG_SCHEMA,
  },
  {
    title: 'Object storage',
    rationale:
      'Holds uploaded knowledge documents and fetched inbound media. Any S3-compatible endpoint: a container on a laptop or VPS, or a managed bucket in the cloud. The only protocol difference between those is STORAGE_ADDRESSING_STYLE, which is configured rather than detected — detecting it would be environment-tier branching, which environment-portability.md forbids outright.',
    schema: STORAGE_CONFIG_SCHEMA,
  },
];

/** Every key the platform reads, sorted. */
export function configKeys(): readonly string[] {
  return PLATFORM_CONFIG_SCHEMAS.flatMap((section) => Object.keys(section.schema)).sort();
}

const PREAMBLE = `<!--
  GENERATED FILE — do not edit by hand.

  Regenerate with \`npm run config-reference\`. A test fails the build when this
  file no longer matches the schemas, because \`environment-portability.md\`
  requires the documented configuration list be complete enough to explain every
  behavioural difference between deployment tiers, and a hand-maintained list
  stops being that on the second key anyone adds.
-->

# Configuration reference

Every value the platform reads from its environment. There is nothing else: no
configuration file, no flag, and no branch on which tier is running. That last
part is a requirement rather than a style choice — \`environment-portability.md\`
requires that the same artifact run on a personal computer, a low-cost VPS, and a
managed cloud provider "given only environment-appropriate configuration values",
and separately that no logic branch on detecting which of those it is. So this
list is the complete answer to "what differs between our deployments".

Startup collects **every** missing or invalid key and fails with all of them at
once, rather than one per restart.

Values marked **(secret)** arrive wrapped so they cannot be logged or serialised
by accident. Never place one in a URL, a command line, or a container image.
`;

/** The reference document, byte for byte as it is committed. */
export function renderPlatformReference(): string {
  const sections = PLATFORM_CONFIG_SCHEMAS.map(
    (section) => `## ${section.title}\n\n${section.rationale}\n\n${tableOnly(section.schema)}`,
  );
  return `${PREAMBLE}\n${sections.join('\n\n')}\n\n## Template\n\n\`\`\`sh\n${renderEnvTemplate(
    combinedSchema(),
  )}\`\`\`\n`;
}

function combinedSchema(): ConfigSchema {
  return Object.assign({}, ...PLATFORM_CONFIG_SCHEMAS.map((section) => section.schema));
}

/**
 * `renderReference` emits its own heading; the sections above supply theirs, so
 * the generated title line is dropped rather than nested one level deeper.
 */
function tableOnly(schema: ConfigSchema): string {
  const rendered = renderReference(schema);
  const table = rendered.slice(rendered.indexOf('| Variable'));
  return table.trimEnd();
}
