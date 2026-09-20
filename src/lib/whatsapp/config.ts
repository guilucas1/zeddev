/**
 * The WhatsApp Business Cloud API settings the platform holds as one Meta app.
 *
 * Platform-wide, not per tenant: every client's number is authorized to the
 * platform's single Meta app, and Meta signs every webhook notification with that
 * app's secret. Per-tenant credentials (a client's access token) are tenant
 * secrets and live in `tenant_secrets`, never here.
 */

import { loadConfig, type Config, type ConfigSchema, type RawEnv } from '@zeddev/config';

export const WHATSAPP_CONFIG_SCHEMA = {
  WHATSAPP_APP_SECRET: {
    type: 'string',
    description:
      "The Meta app's secret. Every inbound webhook notification carries an HMAC-SHA256 of its body keyed with it (X-Hub-Signature-256), and a notification whose signature does not verify is refused and recorded rather than processed — message-delivery-reliability.md AC2. Without it anyone who finds the webhook URL could inject messages into any tenant's conversations.",
    secret: true,
    minLength: 16,
  },
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: {
    type: 'string',
    description:
      'A value you choose and enter in the Meta app dashboard when subscribing the webhook. Meta echoes it once in a GET handshake to prove the subscription request came from the dashboard you control; the gateway answers the handshake only when it matches.',
    secret: true,
    minLength: 16,
  },
  WHATSAPP_APP_ID: {
    type: 'string',
    pattern: /^[0-9]{1,32}$/,
    description:
      "The Meta app's numeric id. A client's WhatsApp Business Account has to be subscribed to this app before Meta will deliver its messages here, and the connection flow both performs that subscription and checks it — which is why the id has to be known, not just the secret.",
    example: '3090001111',
  },
  WHATSAPP_API_BASE_URL: {
    type: 'url',
    protocols: ['http', 'https'],
    description:
      'Versioned Graph API root the adapter appends its paths to, including the version segment. Always stated, never defaulted: an embedded vendor URL pins the deployment to one upstream and to one API version, so it could be pointed at neither a sandbox nor a recorded stub without a code change, and a version bump would stop being a configuration change.',
    example: 'https://example.com/v21.0',
  },
  WHATSAPP_REQUEST_TIMEOUT: {
    type: 'duration',
    description:
      'How long one Graph API call may take, including reading the response. Exceeding it counts as a transient failure: a timeout is no evidence about the credentials, so it must never move a working connection to error.',
    default: 15_000,
    min: 1_000,
    max: 120_000,
  },
  WHATSAPP_VERIFICATION_TTL: {
    type: 'duration',
    description:
      'How long a client has to reply with the connection code before the attempt is abandoned and the connection reports verification_failed. Long enough to find the phone, short enough that a code seen over someone’s shoulder is not useful later.',
    default: 15 * 60_000,
    min: 60_000,
    max: 24 * 60 * 60_000,
  },
} as const satisfies ConfigSchema;

export type WhatsAppConfig = Config<typeof WHATSAPP_CONFIG_SCHEMA>;

export function loadWhatsAppConfig(env: RawEnv = process.env): WhatsAppConfig {
  return loadConfig(WHATSAPP_CONFIG_SCHEMA, env);
}

/** The settings the Graph adapter takes, from the same one load. */
export function loadGraphCloudSettings(env: RawEnv = process.env): {
  readonly baseUrl: string;
  readonly appId: string;
  readonly requestTimeoutMs: number;
} {
  const config = loadWhatsAppConfig(env);
  return {
    baseUrl: config.WHATSAPP_API_BASE_URL,
    appId: config.WHATSAPP_APP_ID,
    requestTimeoutMs: config.WHATSAPP_REQUEST_TIMEOUT,
  };
}
