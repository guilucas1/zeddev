/**
 * The WhatsApp gateway's environment schema.
 *
 * Only what is a property of *this* service lives here. The Meta app secret and
 * webhook verify token belong to `@zeddev/whatsapp` (the future outbound sender
 * needs the same app), database and logging keys to their own packages.
 *
 * Its own listener, separate from the API's, because
 * `message-delivery-reliability.md` requires inbound acknowledgement be prompt and
 * independent of everything else the platform is doing, and
 * `component-independence.md` requires each unit be deployable and restartable on
 * its own: a redeploy of the dashboard API must not make Meta redeliver.
 */

import { loadConfig, type Config, type ConfigSchema, type RawEnv } from '@zeddev/config';

export const GATEWAY_CONFIG_SCHEMA = {
  GATEWAY_HTTP_HOST: {
    type: 'string',
    description:
      'Address the webhook listener binds to. The default listens on every interface, which is what a container needs.',
    default: '0.0.0.0',
  },
  GATEWAY_HTTP_PORT: {
    type: 'integer',
    description:
      "TCP port the webhook listener binds to. Meta must reach it over public HTTPS, so on a VPS or laptop a TLS-terminating reverse proxy or tunnel forwards to it; the URL Meta is given is that proxy's, followed by /v1/whatsapp/webhook. 0 asks the operating system for any free port, which is only useful to a test harness.",
    default: 8081,
    min: 0,
    max: 65535,
  },
  GATEWAY_MAX_BODY_BYTES: {
    type: 'integer',
    description:
      'Largest webhook notification accepted, in bytes. Notifications carry message text and media references, never media itself, so they are small; the bound stops a caller making the gateway hash and buffer megabytes before the signature check refuses them.',
    default: 256 * 1024,
    min: 16 * 1024,
    max: 4 * 1024 * 1024,
  },
  GATEWAY_REQUEST_TIMEOUT: {
    type: 'duration',
    description:
      'How long one notification may take to arrive in full and be acknowledged before the connection is dropped. Meta treats a slow acknowledgement as a failure and redelivers, so this bounds a slow client, not the gateway: acknowledging is a signature check and one short transaction.',
    default: 10_000,
    min: 1000,
  },
  GATEWAY_SHUTDOWN_GRACE: {
    type: 'duration',
    description:
      'On a stop signal, how long in-flight notifications are given to be stored and acknowledged before connections are closed. One cut short is not lost: it was never acknowledged, so Meta redelivers it, and duplicate suppression makes the redelivery safe.',
    default: 10_000,
    min: 0,
  },
} as const satisfies ConfigSchema;

export type GatewayConfig = Config<typeof GATEWAY_CONFIG_SCHEMA>;

export interface GatewaySettings {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly requestTimeoutMs: number;
  readonly shutdownGraceMs: number;
}

export function loadGatewaySettings(env: RawEnv = process.env): GatewaySettings {
  const config = loadConfig(GATEWAY_CONFIG_SCHEMA, env);
  return {
    host: config.GATEWAY_HTTP_HOST,
    port: config.GATEWAY_HTTP_PORT,
    maxBodyBytes: config.GATEWAY_MAX_BODY_BYTES,
    requestTimeoutMs: config.GATEWAY_REQUEST_TIMEOUT,
    shutdownGraceMs: config.GATEWAY_SHUTDOWN_GRACE,
  };
}
