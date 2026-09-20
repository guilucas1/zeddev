/**
 * Runs the one conformance suite against the fake and against the real Graph
 * adapter talking to a stub of Meta. See `conformance.ts` for why one suite, and
 * `stubs.ts` for why a stub rather than the live API.
 */

import { GraphWhatsAppCloud } from './graph.ts';
import { InMemoryWhatsAppCloud, runWhatsAppCloudConformance, startGraphStub } from './testing.ts';

const APP_ID = '3090001111';

runWhatsAppCloudConformance({
  label: 'in-memory',
  create: async () => {
    const cloud = new InMemoryWhatsAppCloud({ appId: APP_ID });
    return { cloud, backend: cloud.backend, appId: APP_ID, dispose: async () => {} };
  },
});

runWhatsAppCloudConformance({
  label: 'graph',
  create: async () => {
    const stub = await startGraphStub();
    const cloud = new GraphWhatsAppCloud({ baseUrl: stub.baseUrl, appId: APP_ID, requestTimeoutMs: 5_000 });
    return { cloud, backend: stub.backend, appId: APP_ID, dispose: () => stub.close() };
  },
});
