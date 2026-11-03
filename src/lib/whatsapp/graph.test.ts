/**
 * What only the Graph adapter can get wrong about media.
 *
 * The conformance suite holds the adapter and the fake to the same answers. These
 * are the answers a well-behaved stub never provokes: a location that would carry
 * the token in the clear, a 200 that is not media, and a body bigger than every
 * header claimed. `fetch` is injected for them because producing each is the point,
 * and the adapter's only collaborator here is the response it is handed.
 */

import assert from 'node:assert/strict';
import { TransientTransportError } from '@zeddev/errors';
import { Secret } from '@zeddev/secrets';
import { unitTest } from '@zeddev/testing';
import { isMediaTooLarge, type CloudCredentials } from './cloud.ts';
import { GraphWhatsAppCloud } from './graph.ts';

const ROOT = 'https://example.com/v21.0';
const MEDIA_ID = '7100';
const SIGNED_LOCATION = 'https://example.org/media?signature=signed-link-marker';

const credentials: CloudCredentials = {
  accessToken: new Secret(['graph', 'test', 'value'].join('-'), 'tenant_whatsapp_credential'),
  phoneNumberId: '15550001111',
  businessAccountId: '20220002222',
};

interface Seen {
  readonly url: string;
  readonly authorization: string | null;
}

/** An adapter whose first exchange names `location` and whose second is `download`. */
function adapter(
  location: string,
  download: () => Response,
  described: Readonly<Record<string, unknown>> = {},
): { readonly cloud: GraphWhatsAppCloud; readonly seen: Seen[] } {
  const seen: Seen[] = [];
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    seen.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    if (url.startsWith(ROOT)) {
      return Response.json({ url: location, mime_type: 'image/jpeg', ...described });
    }
    return download();
  };
  return {
    cloud: new GraphWhatsAppCloud({ baseUrl: ROOT, appId: '3090001111', requestTimeoutMs: 1_000 }, { fetch: fake }),
    seen,
  };
}

function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

unitTest('the lookup names the receiving number, and the token follows the location Meta gave', async () => {
  const { cloud, seen } = adapter(SIGNED_LOCATION, () => new Response(Uint8Array.of(9, 8, 7)));
  const media = await cloud.fetchMedia(credentials, { mediaId: MEDIA_ID, maxBytes: 100 });
  assert.deepEqual(Buffer.from(media.data), Buffer.from([9, 8, 7]));
  assert.match(seen[0]!.url, /\/v21\.0\/7100\?phone_number_id=15550001111$/);
  assert.equal(seen[1]!.url, SIGNED_LOCATION);
  assert.match(seen[1]!.authorization ?? '', /^Bearer /);
});

unitTest('a location that would carry the token in the clear is refused before it is sent there', async () => {
  const { cloud, seen } = adapter('http://example.org/media', () => new Response(Uint8Array.of(1)));
  const error = await failureOf(cloud.fetchMedia(credentials, { mediaId: MEDIA_ID, maxBytes: 100 }));
  assert.ok(error instanceof TransientTransportError);
  assert.equal(seen.length, 1, 'nothing may be requested from the refused location');
});

unitTest('a missing location is a malformed answer, not a crash', async () => {
  const { cloud } = adapter('', () => new Response(Uint8Array.of(1)));
  const error = await failureOf(cloud.fetchMedia(credentials, { mediaId: MEDIA_ID, maxBytes: 100 }));
  assert.ok(error instanceof TransientTransportError);
  assert.equal(error.code, 'whatsapp.cloud.malformed_response');
});

unitTest('a web page answering a media download is not handed on as a photo', async () => {
  const page = (): Response => new Response('<html>update your browser</html>', { headers: { 'content-type': 'text/html; charset=utf-8' } });
  const { cloud } = adapter(SIGNED_LOCATION, page);
  const error = await failureOf(cloud.fetchMedia(credentials, { mediaId: MEDIA_ID, maxBytes: 1000 }));
  assert.ok(error instanceof TransientTransportError);
  assert.equal(error.retryable, true);
});

unitTest('the bound holds against a body no header admitted to', async () => {
  // A stream with no content-length, and a lookup that declares no size.
  let delivered = 0;
  const endless = (): Response =>
    new Response(
      new ReadableStream({
        pull(controller) {
          delivered += 64;
          controller.enqueue(new Uint8Array(64));
        },
      }),
    );
  const { cloud } = adapter(SIGNED_LOCATION, endless);
  const error = await failureOf(cloud.fetchMedia(credentials, { mediaId: MEDIA_ID, maxBytes: 100 }));
  assert.equal(isMediaTooLarge(error), true);
  assert.ok(delivered < 1_000, 'reading must stop at the bound rather than at the end of the body');
});

unitTest('a size Meta admits to past the limit stops the download before it starts, in either form', async () => {
  for (const fileSize of [101, '101']) {
    const { cloud, seen } = adapter(SIGNED_LOCATION, () => new Response(Uint8Array.of(1)), { file_size: fileSize });
    const error = await failureOf(cloud.fetchMedia(credentials, { mediaId: MEDIA_ID, maxBytes: 100 }));
    assert.equal(isMediaTooLarge(error), true);
    assert.equal(seen.length, 1);
  }
});

unitTest('the signed link never reaches a diagnostic', async () => {
  const refused = (): Response => Response.json({ error: { code: 131000, message: 'quoted' } }, { status: 500 });
  const { cloud } = adapter(SIGNED_LOCATION, refused);
  const error = await failureOf(cloud.fetchMedia(credentials, { mediaId: MEDIA_ID, maxBytes: 100 }));
  assert.ok(error instanceof TransientTransportError);
  const rendered = JSON.stringify(error.toDiagnostic()) + error.message;
  assert.equal(rendered.includes('signed-link-marker'), false);
  assert.equal(rendered.includes(credentials.accessToken.expose()), false);
});
