/**
 * The dashboard's one route to the API.
 *
 * Every failure becomes an `ApiError` carrying the API's own code, so a screen
 * decides what to do by code. A dropped connection and a reply that is not JSON are
 * failures of the same kind and are given codes too, so no screen has to think
 * about `fetch` rejecting.
 */

export interface ApiIssue {
  readonly key: string;
  readonly reason: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: readonly ApiIssue[];
  /** Only a conflict carries human-readable text from the API. */
  readonly detail: string | undefined;
  readonly retryAfterSeconds: number | undefined;
  /** On `service.unavailable`, which part of the platform could not be reached, when it is known. */
  readonly component: string | undefined;

  constructor(
    status: number,
    code: string,
    extra: {
      readonly issues?: readonly ApiIssue[];
      readonly detail?: string | undefined;
      readonly retryAfterSeconds?: number | undefined;
      readonly component?: string | undefined;
    } = {},
  ) {
    super(code);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = extra.issues ?? [];
    this.detail = extra.detail;
    this.retryAfterSeconds = extra.retryAfterSeconds;
    this.component = extra.component;
  }
}

/** The part of `Response` used here. */
export interface ResponseLike {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  path: string,
  init: { readonly method: string; readonly headers: Record<string, string>; readonly body?: string; readonly credentials: 'same-origin' },
) => Promise<ResponseLike>;

interface ErrorBody {
  readonly error?: {
    readonly code?: string;
    readonly issues?: readonly ApiIssue[];
    readonly message?: string;
    readonly component?: string;
  };
}

export class Api {
  readonly #fetch: FetchLike;

  constructor(fetchLike: FetchLike) {
    this.#fetch = fetchLike;
  }

  get<T>(path: string): Promise<T> {
    return this.#send<T>('GET', path);
  }

  post<T>(path: string, body: unknown = {}): Promise<T> {
    return this.#send<T>('POST', path, body);
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return this.#send<T>('PUT', path, body);
  }

  delete<T>(path: string): Promise<T> {
    return this.#send<T>('DELETE', path);
  }

  async #send<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: ResponseLike;
    try {
      response = await this.#fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: 'same-origin',
      });
    } catch {
      throw new ApiError(0, 'network');
    }

    const text = await response.text().catch(() => '');
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new ApiError(response.status, 'internal');
    }

    if (response.ok) return parsed as T;

    const error = (parsed as ErrorBody | undefined)?.error;
    const retryAfter = Number(response.headers.get('retry-after'));
    throw new ApiError(response.status, error?.code ?? 'internal', {
      issues: error?.issues ?? [],
      detail: error?.message,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      component: typeof error?.component === 'string' ? error.component : undefined,
    });
  }
}
