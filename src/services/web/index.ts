/** `@zeddev/web` — the client and operator dashboards, and the one origin they share with the API. */

export { createWeb, type Web, type WebDependencies } from './app.ts';
export { loadAssets, type Asset, type Assets } from './assets.ts';
export { loadWebSettings, WEB_CONFIG_SCHEMA, type WebSettings } from './config.ts';
export { startWeb, type RunningWeb, type StartWebOptions } from './start.ts';
