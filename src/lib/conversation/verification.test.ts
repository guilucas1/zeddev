/**
 * The AI provider verification suite — `ai-provider-portability.md` AC4.
 *
 * Run against `InMemoryAiProvider`, which goes through the same request
 * normalisation and retry loop as the real adapters, so "the candidate was shown
 * exactly what a live reply shows" is asserted against what the model received.
 * The suite's value is that it fails a model that would fail live traffic, so most
 * of these tests are about models that misbehave.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { InMemoryAiProvider, type ObservedGeneration, type ObservedRequest, type ObservedTranscription } from '@zeddev/ai/testing';
import { replyInstructions } from '@zeddev/bot';
import { ValidationError } from '@zeddev/errors';
import { specTest, unitTest } from '@zeddev/testing';
import { FakeClock } from '@zeddev/time';
import {
  parseVerificationInput,
  SILENT_WAV,
  SOLID_RED_PNG,
  VERIFICATION_CHECKS,
  VERIFICATION_CONFIGURATION,
  verifyAiProvider,
} from './verification.ts';

/** A model that does what a working one does for each question the suite asks. */
function competent(request: ObservedRequest): string {
  if (request.operation === 'transcribe') return '';
  const parts = request.turns.at(-1)!.parts;
  if (parts.some((part) => part.type === 'image')) return 'A plain red square, with nothing else in it.';
  const text = parts.map((part) => (part.type === 'text' ? part.text : '')).join(' ');
  if (text.includes('real person')) return '[handoff] human_request';
  if (text.includes('vote')) return '[fallback] out_of_scope';
  return '[reply]\nHi! On Saturdays we open at 8:00.';
}

const FULL = new InMemoryAiProvider().descriptor;

specTest(
  'ai-provider-portability.md',
  'AC4 a new provider can be verified before it serves live conversations',
  'a provider that answers as the reply path needs passes every check, and was shown exactly what a live reply shows',
  async () => {
    const candidate = new InMemoryAiProvider({ model: 'candidate-model', reply: competent });
    const result = await verifyAiProvider(candidate, { active: FULL, clock: new FakeClock(new Date('2026-11-13T10:00:00Z')) });

    assert.equal(result.passed, true);
    assert.deepEqual(result.capabilityGaps, []);
    assert.deepEqual(result.provider, candidate.descriptor);
    assert.deepEqual(result.verifiedAt, new Date('2026-11-13T10:00:00Z'));
    assert.deepEqual(
      result.checks.map((check) => [check.check, check.outcome, check.errorCode]),
      VERIFICATION_CHECKS.map((check) => [check, 'passed', null]),
    );
    const byCheck = new Map(result.checks.map((check) => [check.check, check]));
    assert.equal(byCheck.get('reply')!.observed, 'Hi! On Saturdays we open at 8:00.', 'the tag is stripped, as for a customer');
    assert.equal(byCheck.get('handoff')!.observed, 'Handed over to a person (human_request).');
    assert.equal(byCheck.get('audio')!.observed, 'Heard no speech.');

    // The same instructions a live opening reply renders from this configuration:
    // nothing about verification is a prompt of its own.
    const requests = candidate.backend.requests;
    assert.equal(requests.length, VERIFICATION_CHECKS.length, 'one request per check, nothing retried');
    const first = requests[0] as ObservedGeneration;
    assert.equal(first.instructions, replyInstructions(VERIFICATION_CONFIGURATION, { conversationStart: true }));
    const image = (requests[3] as ObservedGeneration).turns[0]!.parts.find((part) => part.type === 'image');
    assert.ok(image !== undefined && image.mediaType === 'image/png' && Buffer.from(SOLID_RED_PNG).equals(image.data));
    const audio = requests[4] as ObservedTranscription;
    assert.equal(audio.mediaType, 'audio/wav');
    assert.ok(Buffer.from(SILENT_WAV).equals(audio.data));
  },
);

specTest(
  'ai-provider-portability.md',
  'AC4 a new provider can be verified before it serves live conversations',
  'a model that ignores the output protocol fails the checks that depend on it, and the operator sees what it said',
  async () => {
    // The commonest way a swap goes wrong: a model that chats instead of tagging.
    // Live, that is not an outage but a quiet rise in handoffs never taken and
    // topics never declined.
    const candidate = new InMemoryAiProvider({ reply: () => 'Sure, happy to help with that!' });
    const result = await verifyAiProvider(candidate, { active: FULL });
    const outcome = new Map(result.checks.map((check) => [check.check, check]));
    assert.equal(result.passed, false);
    assert.equal(outcome.get('reply')!.outcome, 'failed', 'a reply that does not quote the fact it was given');
    assert.equal(outcome.get('handoff')!.outcome, 'failed');
    assert.equal(outcome.get('handoff')!.observed, 'Sure, happy to help with that!');
    assert.equal(outcome.get('decline')!.outcome, 'failed');
    assert.equal(outcome.get('vision')!.outcome, 'failed', 'a description that does not say red');
    assert.equal(outcome.get('audio')!.outcome, 'passed', 'any answer to silence will do');
  },
);

unitTest('a misplaced tag is reported as the fallback the reply path would take, not as text', async () => {
  const candidate = new InMemoryAiProvider({ reply: () => 'Let me check.\n[handoff] human_request' });
  const result = await verifyAiProvider(candidate, { active: FULL });
  const handoff = result.checks.find((check) => check.check === 'handoff')!;
  assert.equal(handoff.outcome, 'failed');
  assert.equal(handoff.observed, "Fell back to the business's own message (ai_error, unusable_output).");
});

specTest(
  'ai-provider-portability.md',
  'AC4 a new provider can be verified before it serves live conversations',
  'a provider that refuses the credential fails every check with the reason, and the suite itself does not throw',
  async () => {
    const candidate = new InMemoryAiProvider();
    for (let i = 0; i < VERIFICATION_CHECKS.length; i += 1) candidate.backend.script({ kind: 'failure', failure: 'unauthorized' });
    const result = await verifyAiProvider(candidate, { active: FULL });
    assert.equal(result.passed, false);
    for (const check of result.checks) {
      assert.equal(check.outcome, 'failed', check.check);
      assert.equal(check.errorCode, 'ai.unauthorized', check.check);
      assert.equal(check.observed, null, check.check);
    }
    assert.equal(candidate.backend.requests.length, VERIFICATION_CHECKS.length, 'a rejected credential is not retried');
  },
);

specTest(
  'ai-provider-portability.md',
  'AC3 text, image, and voice keep working after a swap to a provider that supports them',
  'verification reports each capability the active provider has and the candidate lacks, and asks the candidate nothing it cannot do',
  async () => {
    const candidate = new InMemoryAiProvider({ capabilities: ['text'], reply: competent });
    const result = await verifyAiProvider(candidate, { active: FULL });
    assert.deepEqual(result.capabilityGaps, ['vision', 'audio']);
    assert.deepEqual(
      result.checks.filter((check) => check.outcome === 'skipped').map((check) => check.check),
      ['vision', 'audio'],
    );
    assert.equal(result.passed, true, 'a gap is the operator\'s to accept, not a failure');
    assert.equal(candidate.backend.requests.length, 3, 'only the text checks were sent');

    const same = await verifyAiProvider(new InMemoryAiProvider({ reply: competent }), { active: FULL });
    assert.deepEqual(same.capabilityGaps, [], 'verifying the active provider itself has nothing to compare');
  },
);

unitTest('durations are measured on the injected clock, one per check', async () => {
  const clock = new FakeClock(new Date('2026-11-13T10:00:00Z'));
  const candidate = new InMemoryAiProvider({
    reply: (request) => {
      void clock.advance(250);
      return competent(request);
    },
  });
  const result = await verifyAiProvider(candidate, { active: FULL, clock });
  assert.deepEqual(result.checks.map((check) => check.durationMs), [250, 250, 250, 250, 250]);
});

unitTest('the photo is a well-formed solid red PNG and the clip a well-formed second of silence', () => {
  const png = Buffer.from(SOLID_RED_PNG);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  const [width, height] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.deepEqual([width, height, png[24], png[25]], [64, 64, 8, 2]);
  const idatLength = png.readUInt32BE(33);
  assert.equal(png.toString('ascii', 37, 41), 'IDAT');
  const pixels = inflateSync(png.subarray(41, 41 + idatLength));
  assert.equal(pixels.length, height * (1 + width * 3));
  for (let y = 0; y < height; y += 1) {
    const row = pixels.subarray(y * (1 + width * 3), (y + 1) * (1 + width * 3));
    assert.equal(row[0], 0, 'unfiltered');
    for (let x = 0; x < width; x += 1) assert.deepEqual([...row.subarray(1 + x * 3, 4 + x * 3)], [220, 20, 20]);
  }

  const wav = Buffer.from(SILENT_WAV);
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.toString('ascii', 8, 16), 'WAVEfmt ');
  assert.deepEqual([wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34)], [1, 1, 16_000, 16]);
  assert.equal(wav.readUInt32LE(40), 32_000);
  assert.ok(wav.subarray(44).every((byte) => byte === 0));
});

unitTest('a verification names its target, and nothing else', () => {
  assert.equal(parseVerificationInput({ target: 'candidate' }), 'candidate');
  assert.equal(parseVerificationInput({ target: 'active' }), 'active');
  assert.throws(
    () => parseVerificationInput({ target: 'both', message: 'hi' }),
    (error: unknown) => error instanceof ValidationError && error.issues.map((issue) => issue.key).join() === 'message,target',
  );
  assert.throws(() => parseVerificationInput({}), ValidationError);
});

specTest(
  'ai-provider-portability.md',
  'AC4 a new provider can be verified before it serves live conversations',
  'no service but the API reads the candidate slot, so a candidate cannot answer a live conversation',
  () => {
    // Structural, because the guarantee is an absence: the conversation worker and
    // the scheduler are built from AI_* alone.
    const services = join(import.meta.dirname, '..', '..', 'services');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        // The identifiers that load or hold the slot. A screen naming the keys in
        // its help text does not read them.
        else if (name.endsWith('.ts') && /loadAiCandidateSettings|AI_CANDIDATE_CONFIG_SCHEMA|candidateAi/.test(readFileSync(path, 'utf8'))) {
          offenders.push(path.slice(services.length + 1).replaceAll('\\', '/'));
        }
      }
    };
    walk(services);
    assert.ok(offenders.length > 0, 'the API does read it');
    assert.deepEqual(
      offenders.filter((path) => !path.startsWith('api/')),
      [],
    );
  },
);
