/**
 * The mail environment schema.
 *
 * Discrete keys rather than an SMTP URL, on the reasoning §1 of
 * IMPLEMENTATION_PLAN.md records for the database and object storage: a
 * `smtp://user:password@host:587` URL is one string containing a credential, so
 * every accidental disclosure of it — a log line, a crash dump, a process listing
 * — is a credential disclosure. Discrete keys let exactly `MAIL_PASSWORD` be
 * marked `secret`, so it arrives wrapped in `Secret` and cannot be serialised by
 * accident.
 *
 * These keys are also the complete answer to why mail differs between a laptop, a
 * VPS, and a managed cloud, which is what `environment-portability.md` AC6 asks
 * of the configuration list: the address, how TLS is reached, the credentials,
 * the announced name, and the timeouts. Nothing about which tier is running is
 * discoverable from inside the process, which is what AC5 requires — and the most
 * tempting violation is specifically avoided here, because choosing TLS from the
 * port number is environment detection by another name.
 */

import { loadConfig, type Config, type ConfigSchema, type RawEnv } from '@zeddev/config';
import { MAIL_TLS_MODES, type MailTlsMode, type SmtpSettings } from './types.ts';

export const MAIL_CONFIG_SCHEMA = {
  MAIL_HOST: {
    type: 'string',
    description:
      'Hostname or address of the SMTP server. A container name on a single host, or a provider relay in a managed cloud.',
    example: 'mail',
  },
  MAIL_PORT: {
    type: 'integer',
    description:
      'TCP port of the SMTP server. 587 for submission with STARTTLS, 465 for implicit TLS, 25 for a local relay. Setting it does not change how TLS is reached — MAIL_TLS does.',
    default: 587,
    min: 1,
    max: 65535,
  },
  MAIL_TLS: {
    type: 'enum',
    values: MAIL_TLS_MODES,
    description:
      'How TLS is reached: "starttls" upgrades an established cleartext connection and fails if the server does not offer it, "implicit" speaks TLS from the first byte, "disable" does not encrypt at all and is appropriate only over a trusted local network such as a container network on a single host. There is deliberately no opportunistic mode — a silent fallback to cleartext is a downgrade nothing observes.',
    default: 'starttls',
  },
  MAIL_CA_CERTIFICATE: {
    type: 'string',
    description:
      'PEM certificate authority bundle, for a server whose certificate is not signed by a public root. Empty means use the system trust store. This, rather than a switch that turns verification off, is how a self-signed relay is trusted.',
    default: '',
  },
  MAIL_USERNAME: {
    type: 'string',
    description:
      'Account to authenticate as. Empty means do not authenticate, which is correct for a local relay that accepts mail from its own host and for nothing else.',
    default: '',
  },
  MAIL_PASSWORD: {
    type: 'string',
    description: 'Password paired with the username. Ignored when MAIL_USERNAME is empty.',
    default: '',
    secret: true,
  },
  MAIL_ALLOW_INSECURE_AUTH: {
    type: 'boolean',
    description:
      'Permit authentication over an unencrypted connection. False by default because AUTH PLAIN over cleartext puts the password on the wire in base64, which is encoding rather than encryption. True is correct only when the server is reached over a trusted local network.',
    default: false,
  },
  MAIL_FROM_ADDRESS: {
    type: 'string',
    description:
      'Address every platform message is sent from, used both as the SMTP envelope sender and in the From header. Its domain also forms the right-hand side of each Message-ID.',
    example: 'no-reply@example.com',
  },
  MAIL_FROM_NAME: {
    type: 'string',
    description:
      'Display name shown beside the from address. Empty sends the bare address, which is valid and is what a deployment without a chosen brand name should do.',
    default: '',
  },
  MAIL_EHLO_NAME: {
    type: 'string',
    description:
      'Name this client announces in EHLO. Many providers reject a sender that does not present a resolvable name, so a real deployment should set this to a hostname that resolves to it. Not derived from the host\'s own name, because that would make behaviour differ between tiers without appearing in this list.',
    default: 'localhost',
  },
  MAIL_CONNECT_TIMEOUT: {
    type: 'duration',
    description: 'How long to wait for a TCP connection to the mail server to be established.',
    default: 10_000,
    min: 100,
  },
  MAIL_COMMAND_TIMEOUT: {
    type: 'duration',
    description:
      'How long to wait for any single reply from the mail server. Bounds how long one wedged delivery can occupy a caller, including a server that accepts the connection and then stalls.',
    default: 30_000,
    min: 100,
  },
  MAIL_MAX_ATTEMPTS: {
    type: 'integer',
    description:
      'How many times a transient mail failure is retried before it is surfaced. Only failures classified as retryable are retried, and a failure after the message body has been committed is never retried, because its outcome is unknown and a retry would deliver a second copy.',
    default: 4,
    min: 1,
    max: 10,
  },
} as const satisfies ConfigSchema;

export type MailConfig = Config<typeof MAIL_CONFIG_SCHEMA>;

export function loadMailConfig(env: RawEnv = process.env): MailConfig {
  return loadConfig(MAIL_CONFIG_SCHEMA, env);
}

/**
 * Parse the environment into the settings the adapter takes.
 *
 * A separate step from `loadMailConfig` so that a caller building settings by
 * hand — a test, or a future service that reads its mail settings from somewhere
 * else — goes through the same shaped value the environment produces, rather than
 * a parallel one that can drift.
 */
export function loadSmtpSettings(env: RawEnv = process.env): SmtpSettings {
  const config = loadMailConfig(env);
  return {
    host: config.MAIL_HOST,
    port: config.MAIL_PORT,
    tls: config.MAIL_TLS as MailTlsMode,
    caCertificate: config.MAIL_CA_CERTIFICATE === '' ? undefined : config.MAIL_CA_CERTIFICATE,
    username: config.MAIL_USERNAME,
    password: config.MAIL_PASSWORD,
    allowInsecureAuth: config.MAIL_ALLOW_INSECURE_AUTH,
    fromAddress: config.MAIL_FROM_ADDRESS,
    fromName: config.MAIL_FROM_NAME,
    ehloName: config.MAIL_EHLO_NAME,
    connectTimeoutMs: config.MAIL_CONNECT_TIMEOUT,
    commandTimeoutMs: config.MAIL_COMMAND_TIMEOUT,
    maxAttempts: config.MAIL_MAX_ATTEMPTS,
  };
}
