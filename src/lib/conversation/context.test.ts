/**
 * Rendering a conversation for the model — pure, no database.
 *
 * What matters is what the model is *not* told: an image that could not be seen
 * is announced as such rather than described, and a turn of nothing but such
 * notes is flagged so it never reaches the model at all.
 */

import assert from 'node:assert/strict';
import { unitTest } from '@zeddev/testing';
import { renderConversation, renderMessage } from './context.ts';

unitTest('text is the customer’s own words; a blank text is not understood', () => {
  assert.deepEqual(renderMessage({ type: 'text', upstreamType: 'text', content: { text: '  hi  ' } }), {
    parts: [{ type: 'text', text: 'hi' }],
    understood: true,
  });
  assert.equal(renderMessage({ type: 'text', upstreamType: 'text', content: { text: '   ' } }).understood, false);
});

unitTest('an image is announced as unseen; its caption counts as understood', () => {
  const bare = renderMessage({ type: 'image', upstreamType: 'image', content: { mediaId: '1', mimeType: 'image/png' } });
  assert.equal(bare.understood, false);
  assert.match(bare.parts[0]!.text, /could not be viewed/);
  const captioned = renderMessage({
    type: 'image',
    upstreamType: 'image',
    content: { mediaId: '1', mimeType: 'image/png', caption: 'the red one' },
  });
  assert.equal(captioned.understood, true);
  assert.equal(captioned.parts.at(-1)!.text, 'the red one');
});

unitTest('an unsupported type is named by its upstream type, nothing else', () => {
  const rendered = renderMessage({ type: 'unsupported', upstreamType: 'contacts', content: {} });
  assert.equal(rendered.understood, false);
  assert.match(rendered.parts[0]!.text, /"contacts"/);
});

unitTest('earlier turns carry the bot’s answers; the current turn is last and has none', () => {
  const rendered = renderConversation([
    { messages: [{ type: 'text', upstreamType: 'text', content: { text: 'one' } }], botMessage: 'answer one' },
    { messages: [{ type: 'text', upstreamType: 'text', content: { text: 'paused' } }], botMessage: undefined },
    { messages: [{ type: 'text', upstreamType: 'text', content: { text: 'now' } }], botMessage: 'ignored' },
  ]);
  assert.deepEqual(rendered.turns, [
    { role: 'customer', parts: [{ type: 'text', text: 'one' }] },
    { role: 'bot', text: 'answer one' },
    { role: 'customer', parts: [{ type: 'text', text: 'paused' }] },
    { role: 'customer', parts: [{ type: 'text', text: 'now' }] },
  ]);
  assert.equal(rendered.notUnderstood, undefined);
});

unitTest('a current turn with nothing understood names the fallback trigger it gets', () => {
  const voice = { type: 'audio', upstreamType: 'audio', content: { mediaId: '2', mimeType: 'audio/ogg', voice: true } } as const;
  const sticker = { type: 'unsupported', upstreamType: 'sticker', content: {} } as const;
  assert.equal(renderConversation([{ messages: [voice], botMessage: undefined }]).notUnderstood, 'low_confidence');
  assert.equal(renderConversation([{ messages: [sticker], botMessage: undefined }]).notUnderstood, 'out_of_scope');
  assert.equal(renderConversation([{ messages: [sticker, voice], botMessage: undefined }]).notUnderstood, 'low_confidence');
  // Only the current turn decides: an earlier unreadable turn does not.
  assert.equal(
    renderConversation([
      { messages: [sticker], botMessage: 'fallback text' },
      { messages: [{ type: 'text', upstreamType: 'text', content: { text: 'hello' } }], botMessage: undefined },
    ]).notUnderstood,
    undefined,
  );
});
