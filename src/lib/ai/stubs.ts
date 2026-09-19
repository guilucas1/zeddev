/**
 * Local HTTP servers speaking each upstream's wire format, for testing the real
 * adapters.
 *
 * Why stubs, when `@zeddev/storage` and `@zeddev/mail` insist on real servers:
 * those real servers (MinIO, Mailpit) are free, local, and deterministic. A real
 * model is none of the three — it needs a credential in CI, spends quota the
 * platform's own free tier depends on, and cannot be asked to return a 429, a
 * safety block, or a stalled body on demand. So the division `@zeddev/storage`
 * draws for its transport seam applies here to the whole upstream: fake what cannot
 * be provoked, and here nothing can.
 *
 * What keeps the stubs honest is that they do not just reply — they *decode*. Each
 * request is parsed from the documented wire format back into the port's own
 * vocabulary (`ObservedRequest`) and handed to the same `ScriptedBackend` the fake
 * uses, so the conformance suite's "the model saw exactly this conversation" is
 * checked against what went over the socket, not against what the adapter meant to
 * send. Every failure is produced in the upstream's real shape, including its
 * quirks: Gemini's 400-for-a-bad-key, and error messages that quote the request
 * back (which is what proves the adapters never carry an upstream message into a
 * diagnostic).
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { asRecord } from './attempts.ts';
import { SCRIPTED_FAILURE_STATUS, ScriptedBackend, type ObservedPart, type ObservedRequest, type ScriptedOutcome } from './memory.ts';
import type { AiProviderName } from './types.ts';

export interface WireRecord {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface AiStub {
  /** The value for `AI_BASE_URL`. */
  readonly baseUrl: string;
  readonly backend: ScriptedBackend;
  /** Every HTTP request as it arrived, for assertions about the wire rather than the conversation. */
  readonly wire: readonly WireRecord[];
  close(): Promise<void>;
}

const BASE_PATHS: Readonly<Record<AiProviderName, string>> = {
  gemini: '/v1beta',
  openai_compatible: '/v1',
};

export async function startAiStub(provider: AiProviderName): Promise<AiStub> {
  const backend = new ScriptedBackend();
  const wire: WireRecord[] = [];
  const handle = provider === 'gemini' ? handleGemini : handleOpenAi;

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://stub');
      wire.push({ method: req.method ?? '', path: url.pathname, search: url.search, headers: { ...req.headers } });
      const body = await readBody(req);
      try {
        await handle(backend, req, res, url.pathname.slice(BASE_PATHS[provider].length), body);
      } catch (error) {
        // A decoding failure in the stub is a test failure, and should read like one.
        send(res, 500, { stubError: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { address, port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://${address}:${port}${BASE_PATHS[provider]}`,
    backend,
    wire,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Gemini: POST /models/{model}:generateContent
// ---------------------------------------------------------------------------

async function handleGemini(
  backend: ScriptedBackend,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: Buffer,
): Promise<void> {
  const match = /^\/models\/([^/]+):generateContent$/.exec(path);
  if (req.method !== 'POST' || match === null) return send(res, 404, geminiError(404, 'NOT_FOUND', 'no such route'));

  const model = decodeURIComponent(match[1]!);
  const json = asRecord(JSON.parse(body.toString('utf8')));
  const contents = (json?.['contents'] as unknown[]) ?? [];
  const decodedTurns = contents.map((content) => {
    const record = asRecord(content)!;
    return {
      role: record['role'] === 'model' ? ('bot' as const) : ('customer' as const),
      parts: ((record['parts'] as unknown[]) ?? []).map((p): ObservedPart => {
        const part = asRecord(p)!;
        const inline = asRecord(part['inlineData']);
        if (inline !== undefined) {
          return { type: 'image', mediaType: String(inline['mimeType']), data: Buffer.from(String(inline['data']), 'base64') };
        }
        return { type: 'text', text: String(part['text']) };
      }),
    };
  });

  const audio = decodedTurns.flatMap((t) => t.parts).find((p) => p.type === 'image' && p.mediaType.startsWith('audio/'));
  let observed: ObservedRequest;
  if (audio !== undefined && audio.type === 'image') {
    const prompt = decodedTurns.flatMap((t) => t.parts).find((p) => p.type === 'text');
    const hint = prompt?.type === 'text' ? /BCP 47 tag "([^"]+)"/.exec(prompt.text)?.[1] : undefined;
    observed = { operation: 'transcribe', model, mediaType: audio.mediaType, data: audio.data, languageHint: hint };
  } else {
    const system = asRecord(json?.['systemInstruction']);
    const config = asRecord(json?.['generationConfig']);
    observed = {
      operation: 'generate',
      model,
      instructions: ((system?.['parts'] as unknown[]) ?? []).map((p) => String(asRecord(p)?.['text'])).join(''),
      turns: decodedTurns,
      maxOutputTokens: Number(config?.['maxOutputTokens']),
      temperature: config?.['temperature'] === undefined ? undefined : Number(config['temperature']),
    };
  }

  const outcome = backend.receive(observed);
  const echo = firstText(observed);
  if (outcome.kind === 'text') {
    return send(res, 200, {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: outcome.text }] },
          finishReason: outcome.truncated === true ? 'MAX_TOKENS' : 'STOP',
          index: 0,
        },
      ],
      ...(outcome.usage === undefined
        ? {}
        : {
            usageMetadata: {
              promptTokenCount: outcome.usage.inputTokens,
              candidatesTokenCount: outcome.usage.outputTokens,
              totalTokenCount: outcome.usage.inputTokens + outcome.usage.outputTokens,
            },
          }),
    });
  }

  switch (outcome.failure) {
    case 'filtered':
      return send(res, 200, { promptFeedback: { blockReason: 'SAFETY' } });
    case 'stall':
    case 'unreachable':
      return misbehave(res, outcome);
    case 'unauthorized':
      // Gemini's real answer to a bad key: 400, with the meaning in an ErrorInfo detail.
      return send(res, 400, {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }],
        },
      });
    default: {
      const status = SCRIPTED_FAILURE_STATUS[outcome.failure];
      const grpc = { 429: 'RESOURCE_EXHAUSTED', 503: 'UNAVAILABLE', 404: 'NOT_FOUND', 400: 'INVALID_ARGUMENT' }[status] ?? 'UNKNOWN';
      return send(res, status, geminiError(status, grpc, `Request rejected: ${echo}`), retryAfter(outcome));
    }
  }
}

function geminiError(code: number, status: string, message: string): unknown {
  return { error: { code, message, status } };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible: POST /chat/completions, POST /audio/transcriptions
// ---------------------------------------------------------------------------

async function handleOpenAi(
  backend: ScriptedBackend,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  body: Buffer,
): Promise<void> {
  if (req.method === 'POST' && path === '/audio/transcriptions') {
    // Parsed with the platform's own multipart reader, so the stub sees exactly the parts a server would.
    const form = await new Response(body, { headers: { 'content-type': String(req.headers['content-type']) } }).formData();
    const file = form.get('file');
    if (!(file instanceof Blob)) return send(res, 400, openAiError('file is required', 'invalid_request_error', null));
    const language = form.get('language');
    const observed: ObservedRequest = {
      operation: 'transcribe',
      model: String(form.get('model')),
      mediaType: file.type,
      data: Buffer.from(await file.arrayBuffer()),
      languageHint: typeof language === 'string' ? language : undefined,
    };
    const outcome = backend.receive(observed);
    if (outcome.kind === 'text') return send(res, 200, { text: outcome.text });
    return openAiFailure(res, outcome, '');
  }

  if (req.method !== 'POST' || path !== '/chat/completions') {
    return send(res, 404, openAiError('Unknown request URL', 'invalid_request_error', 'unknown_url'));
  }

  const json = asRecord(JSON.parse(body.toString('utf8')))!;
  const messages = (json['messages'] as unknown[]).map((m) => asRecord(m)!);
  const system = messages.filter((m) => m['role'] === 'system').map((m) => String(m['content']));
  const turns = messages
    .filter((m) => m['role'] !== 'system')
    .map((m) => ({
      role: m['role'] === 'assistant' ? ('bot' as const) : ('customer' as const),
      parts: decodeOpenAiContent(m['content']),
    }));
  const observed: ObservedRequest = {
    operation: 'generate',
    model: String(json['model']),
    instructions: system.join(''),
    turns,
    maxOutputTokens: Number(json['max_tokens']),
    temperature: json['temperature'] === undefined ? undefined : Number(json['temperature']),
  };

  const outcome = backend.receive(observed);
  if (outcome.kind === 'text') {
    return send(res, 200, {
      id: 'chatcmpl-stub',
      object: 'chat.completion',
      model: observed.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: outcome.text, refusal: null },
          finish_reason: outcome.truncated === true ? 'length' : 'stop',
        },
      ],
      ...(outcome.usage === undefined
        ? {}
        : {
            usage: {
              prompt_tokens: outcome.usage.inputTokens,
              completion_tokens: outcome.usage.outputTokens,
              total_tokens: outcome.usage.inputTokens + outcome.usage.outputTokens,
            },
          }),
    });
  }
  return openAiFailure(res, outcome, firstText(observed));
}

function decodeOpenAiContent(content: unknown): ObservedPart[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return (content as unknown[]).map((c): ObservedPart => {
    const part = asRecord(c)!;
    if (part['type'] === 'text') return { type: 'text', text: String(part['text']) };
    const url = String(asRecord(part['image_url'])?.['url']);
    const match = /^data:([^;]+);base64,(.*)$/s.exec(url);
    if (match === null) throw new Error('image_url is not a base64 data URL');
    return { type: 'image', mediaType: match[1]!, data: Buffer.from(match[2]!, 'base64') };
  });
}

function openAiFailure(res: ServerResponse, outcome: Extract<ScriptedOutcome, { kind: 'failure' }>, echo: string): void {
  switch (outcome.failure) {
    case 'filtered':
      return send(res, 200, {
        choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }],
      });
    case 'stall':
    case 'unreachable':
      return misbehave(res, outcome);
    default: {
      const status = SCRIPTED_FAILURE_STATUS[outcome.failure];
      const code = { 429: 'rate_limit_exceeded', 503: null, 401: 'invalid_api_key', 404: 'model_not_found', 400: null }[status] ?? null;
      const type = status === 429 ? 'requests' : status >= 500 ? 'server_error' : 'invalid_request_error';
      return send(res, status, openAiError(`Request rejected: ${echo}`, type, code), retryAfter(outcome));
    }
  }
}

function openAiError(message: string, type: string, code: string | null): unknown {
  return { error: { message, type, param: null, code } };
}

// ---------------------------------------------------------------------------

function firstText(request: ObservedRequest): string {
  if (request.operation === 'transcribe') return '';
  for (const turn of request.turns) for (const part of turn.parts) if (part.type === 'text') return part.text;
  return request.instructions;
}

function retryAfter(outcome: Extract<ScriptedOutcome, { kind: 'failure' }>): Record<string, string> {
  return outcome.retryAfterMs === undefined ? {} : { 'retry-after': String(Math.ceil(outcome.retryAfterMs / 1000)) };
}

/** `stall` never answers; `unreachable` drops the connection without a response. */
function misbehave(res: ServerResponse, outcome: Extract<ScriptedOutcome, { kind: 'failure' }>): void {
  if (outcome.failure === 'unreachable') res.socket?.destroy();
  // A stall is simply never ending the response; `close()` destroys the socket.
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
