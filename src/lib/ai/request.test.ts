import assert from 'node:assert/strict';
import { unitTest } from '@zeddev/testing';
import { audioMediaType, imageMediaType } from './request.ts';

unitTest('WhatsApp media types map onto the port vocabulary, parameters and case notwithstanding', () => {
  assert.equal(audioMediaType('audio/ogg; codecs=opus'), 'audio/ogg');
  assert.equal(audioMediaType('Audio/MPEG'), 'audio/mpeg');
  assert.equal(audioMediaType('audio/mp3'), 'audio/mpeg');
  assert.equal(imageMediaType('image/jpeg'), 'image/jpeg');
});

unitTest('media types some upstream cannot take are refused for every provider alike', () => {
  // AMR and AAC are WhatsApp audio types that not every upstream accepts; refusing
  // them everywhere keeps a swap from changing which voice notes are understood.
  assert.equal(audioMediaType('audio/amr'), undefined);
  assert.equal(audioMediaType('audio/aac'), undefined);
  assert.equal(imageMediaType('image/gif'), undefined);
});
