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
} as const satisfies ConfigSchema;

export type WhatsAppConfig = Config<typeof WHATSAPP_CONFIG_SCHEMA>;

export function loadWhatsAppConfig(env: RawEnv = process.env): WhatsAppConfig {
  return loadConfig(WHATSAPP_CONFIG_SCHEMA, env);
}
