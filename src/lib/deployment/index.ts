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

import { AI_CONFIG_SCHEMA } from '@zeddev/ai';
import { API_CONFIG_SCHEMA } from '@zeddev/api/config';
import { renderEnvTemplate, renderReference, type ConfigSchema } from '@zeddev/config';
import { DATABASE_CONFIG_SCHEMA } from '@zeddev/db';
import { IDENTITY_CONFIG_SCHEMA } from '@zeddev/identity';
import { LOGGING_CONFIG_SCHEMA } from '@zeddev/logging';
import { MAIL_CONFIG_SCHEMA } from '@zeddev/mail';
import { STORAGE_CONFIG_SCHEMA } from '@zeddev/storage';
import { WHATSAPP_CONFIG_SCHEMA } from '@zeddev/whatsapp';
import { GATEWAY_CONFIG_SCHEMA } from '@zeddev/whatsapp-gateway/config';

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
  {
    title: 'Identity and sessions',
    rationale:
      'The session, lockout, and recovery-link bounds that authentication-and-access.md requires be defined but deliberately leaves unspecified. They are configuration rather than constants because a laptop, a VPS, and a managed cloud deployment can legitimately want different values — a demo instance with a short absolute session lifetime, a production one with a longer inactivity window — and environment-portability.md requires every such behavioural difference be explainable from this list. Startup additionally rejects an absolute lifetime shorter than the inactivity timeout, which is individually valid on both keys and jointly leaves only one of the two required expiry rules in force.',
    schema: IDENTITY_CONFIG_SCHEMA,
  },
  {
    title: 'Outbound mail',
    rationale:
      'Carries the email-verification and password-reset links that client-signup-and-tenancy.md and authentication-and-access.md require. Any SMTP server: a container on a laptop, a relay on a VPS, a provider in a managed cloud — one adapter reached through different values, for the same reason object storage has one S3 adapter. MAIL_TLS is stated rather than inferred from the port, because "465 means implicit and 587 means STARTTLS" is environment detection wearing a disguise; and there is deliberately no opportunistic mode, because a silent fallback to cleartext is a downgrade nothing observes until the credentials are already on the wire.',
    schema: MAIL_CONFIG_SCHEMA,
  },
  {
    title: 'AI provider',
    rationale:
      'The model that writes every bot reply, reads images, and transcribes voice notes. ai-provider-portability.md requires swapping it — and reverting the swap — be a configuration change, so these keys are the whole mechanism: one platform-wide selection, applied to every tenant at once, with no per-provider tenant state to migrate. The base URL is always stated rather than defaulted, so a deployment can point the same adapter at a vendor, a gateway, or a local model server without a code change. AI_CAPABILITIES records what the chosen model can do; a message needing anything else is answered with the fallback message the client wrote rather than sent to a model that cannot handle it.',
    schema: AI_CONFIG_SCHEMA,
  },
  {
    title: 'WhatsApp',
    rationale:
      "The platform's one Meta app, which every client's number is authorized to. Platform-wide rather than per tenant: a client's own access token is a tenant secret and never an environment value. Both keys are secrets — the app secret is what proves an inbound notification came from Meta (message-delivery-reliability.md AC2), and without it anyone who found the webhook URL could inject messages into any tenant's conversations.",
    schema: WHATSAPP_CONFIG_SCHEMA,
  },
  {
    title: 'Logging',
    rationale:
      'Read by every service. Verbosity is the only thing that varies; what a record may contain does not, because redaction is an allowlist of field names enforced at the logger boundary and applies at every level.',
    schema: LOGGING_CONFIG_SCHEMA,
  },
  {
    title: 'API service',
    rationale:
      'The client and operator HTTP API. API_PUBLIC_BASE_URL and API_TRUSTED_PROXY_HOPS are the two values most likely to differ between a laptop, a VPS, and a managed cloud, and both are stated rather than inferred from the request: a link built from a caller-supplied Host header lets the caller choose where a password-reset link points, and trusting X-Forwarded-For without knowing how many proxies wrote it lets a caller forge the source address the login throttle counts by.',
    schema: API_CONFIG_SCHEMA,
  },
  {
    title: 'WhatsApp gateway service',
    rationale:
      'The inbound webhook Meta delivers every message to, deployed apart from the API so that acknowledging a notification never waits on anything else the platform is doing — a slow acknowledgement makes Meta redeliver (message-delivery-reliability.md AC1). Meta only calls public HTTPS URLs, so on a laptop or VPS a TLS-terminating proxy or tunnel forwards to GATEWAY_HTTP_PORT; that forwarding is deployment plumbing, not a code path, so it is the same artifact on every tier.',
    schema: GATEWAY_CONFIG_SCHEMA,
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
