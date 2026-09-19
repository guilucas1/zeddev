/**
 * `@zeddev/whatsapp-gateway` — the inbound WhatsApp webhook.
 *
 * Separate from the API so that acknowledging Meta never waits on anything else
 * the platform is doing (IMPLEMENTATION_PLAN.md §1, component map). The process
 * entrypoint is `main.ts`; the configuration schema is also reachable as
 * `@zeddev/whatsapp-gateway/config`, so `@zeddev/deployment` can generate the
 * reference without importing the server.
 */

export { createGateway, WEBHOOK_PATH, type Gateway, type GatewayDependencies, type InboundScheduler } from './app.ts';
export { GATEWAY_CONFIG_SCHEMA, loadGatewaySettings, type GatewaySettings } from './config.ts';
export { startGateway, type RunningGateway, type StartGatewayOptions } from './start.ts';
