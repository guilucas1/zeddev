/**
 * The three deployment tiers, as configuration.
 *
 * `environment-portability.md` asks that the same artifact become fully
 * functional on a personal computer, a low-cost VPS, and a managed cloud
 * provider, "given a documented set of configuration values appropriate for"
 * each. The reference above every tier lists what *can* be set; this says what
 * each tier *does* set differently, and why.
 *
 * It is data rather than prose for the same reason the reference is generated:
 * `tiers.test.ts` starts every service from each tier's values exactly as written
 * here, runs the same end-to-end scenario on each, and requires the three to be
 * indistinguishable from outside. A tier's documented values therefore cannot
 * drift from values that work, and a tier needing anything beyond configuration
 * would fail the build rather than surface on the day someone moves.
 *
 * What a tier holds is the *character* of the tier: transport security on the
 * links it has, resource limits, how many proxies stand in front of the API.
 * What every deployment supplies for itself, whatever its tier — addresses,
 * credentials, the public URL, the Meta app, the model — is deliberately not
 * here, because it says where one deployment lives, not what kind it is. The
 * test enforces the split: its harness supplies only those, and never overrides
 * a value a tier sets.
 */

export interface TierSetting {
  readonly key: string;
  readonly value: string;
  /** Why this tier chooses this value; rendered beside it in the reference. */
  readonly why: string;
}

export interface DeploymentTier {
  readonly id: 'personal_computer' | 'vps' | 'managed_cloud';
  readonly title: string;
  /** What the tier is and how the platform is laid out on it. */
  readonly layout: string;
  readonly settings: readonly TierSetting[];
}

export const DEPLOYMENT_TIERS: readonly DeploymentTier[] = [
  {
    id: 'personal_computer',
    title: 'Personal computer',
    layout:
      '`docker compose --profile local-mail up -d` on one machine: PostgreSQL and Mailpit run beside the services on the Compose network, and the browser reaches `web` directly. Meta reaches the gateway through a tunnel.',
    settings: [
      {
        key: 'DATABASE_SSL_MODE',
        value: 'disable',
        why: 'The database is a container on the same host, reached over the Compose network only.',
      },
      { key: 'DATABASE_POOL_MAX', value: '5', why: 'Five processes share one small PostgreSQL on a machine that is doing other things.' },
      { key: 'WORKER_CONCURRENCY', value: '2', why: 'A handful of test conversations at a time.' },
      { key: 'WORKER_MAX_IN_FLIGHT_PER_TENANT', value: '1', why: 'Below WORKER_CONCURRENCY with one worker, as that key requires.' },
      { key: 'API_TRUSTED_PROXY_HOPS', value: '1', why: '`web` is the only proxy in front of the API.' },
      { key: 'MAIL_TLS', value: 'disable', why: 'Mailpit on the Compose network catches every message; nothing leaves the machine.' },
      { key: 'MAIL_PORT', value: '1025', why: "Mailpit's SMTP port." },
      { key: 'LOG_LEVEL', value: 'debug', why: 'The operator is the developer, reading the logs as they go.' },
    ],
  },
  {
    id: 'vps',
    title: 'Low-cost VPS',
    layout:
      'The same Compose file on one rented host, with a TLS-terminating reverse proxy in front of `web` and of the gateway. PostgreSQL stays on the Compose network; mail goes to a provider relay.',
    settings: [
      {
        key: 'DATABASE_SSL_MODE',
        value: 'disable',
        why: 'The database is still a container on the same host, unreachable from outside the Compose network.',
      },
      { key: 'DATABASE_POOL_MAX', value: '10', why: 'One modest host shared by every service and the database.' },
      { key: 'WORKER_CONCURRENCY', value: '4', why: "Most of a job is waiting on the AI provider, so a small host can hold more than its CPU count." },
      { key: 'WORKER_MAX_IN_FLIGHT_PER_TENANT', value: '2', why: 'Half the worker, so one busy business cannot occupy all of it.' },
      { key: 'API_TRUSTED_PROXY_HOPS', value: '2', why: 'The reverse proxy, then `web`.' },
      { key: 'MAIL_TLS', value: 'starttls', why: 'A provider relay over the internet, on the submission port.' },
      { key: 'MAIL_PORT', value: '587', why: 'The submission port.' },
      { key: 'LOG_LEVEL', value: 'info', why: 'Nobody is watching live; records are for diagnosing afterwards.' },
    ],
  },
  {
    id: 'managed_cloud',
    title: 'Managed cloud provider',
    layout:
      "Each service's image runs on the provider's container platform behind its load balancer, against managed PostgreSQL and a managed mail relay. Workers scale by adding instances.",
    settings: [
      {
        key: 'DATABASE_SSL_MODE',
        value: 'verify-full',
        why: "The database is a managed endpoint across the provider's network, so the link is encrypted and the server must prove it is that endpoint. Connect by the name its certificate carries, and set DATABASE_CA_CERTIFICATE if the provider signs with a private authority.",
      },
      { key: 'DATABASE_POOL_MAX', value: '20', why: 'Managed PostgreSQL allows more connections, and each instance is sized on its own.' },
      { key: 'WORKER_CONCURRENCY', value: '8', why: 'A dedicated instance per worker.' },
      { key: 'WORKER_MAX_IN_FLIGHT_PER_TENANT', value: '4', why: 'Counted across every worker instance, so it stays below their combined concurrency.' },
      { key: 'API_TRUSTED_PROXY_HOPS', value: '2', why: "The provider's load balancer, then `web`." },
      { key: 'MAIL_TLS', value: 'implicit', why: 'A managed relay speaking TLS from the first byte.' },
      { key: 'MAIL_PORT', value: '465', why: 'The implicit-TLS submission port.' },
      { key: 'LOG_LEVEL', value: 'info', why: "Records go to the provider's log store, which charges by volume." },
    ],
  },
];

/** The settings of one tier as an environment fragment. */
export function tierEnvironment(tier: DeploymentTier): Record<string, string> {
  return Object.fromEntries(tier.settings.map((setting) => [setting.key, setting.value]));
}

/** The tiers section of the generated reference. */
export function renderTiers(): string {
  const intro = `## Deployment tiers

What each tier sets differently from the defaults above, and why. Everything not
listed is the same on every tier, apart from what each deployment supplies for
itself whatever its tier: addresses, credentials, \`API_PUBLIC_BASE_URL\`, the Meta
app, and the model. \`src/lib/deployment/tiers.test.ts\` starts every service from
each tier's values exactly as written here and runs the same end-to-end scenario
on all three, so these are values known to work, not suggestions.`;
  const sections = DEPLOYMENT_TIERS.map((tier) => {
    const rows = tier.settings.map((setting) => `| \`${setting.key}\` | \`${setting.value}\` | ${setting.why} |`).join('\n');
    return `### ${tier.title}\n\n${tier.layout}\n\n| Variable | Value | Why |\n| --- | --- | --- |\n${rows}`;
  });
  return `${intro}\n\n${sections.join('\n\n')}`;
}
