import {
  type Approval,
  type CreateApprovalInput,
  type Jwk,
  TIMESTAMP_SKEW_MS,
  WEBHOOK_HEADERS,
  type WebhookBody,
} from "./types";

const DEFAULT_BASE_URL = "https://api.quirna.com";

export type QuirnaClientOptions = {
  /**
   * Your Quirna API key. Required and explicit: where it comes from is the
   * integrator's decision, not ours — reading an env var of our choosing
   * behind their back would be one more invisible thing to get wrong.
   */
  apiKey: string;
  /** Defaults to `QUIRNA_BASE_URL`, then to Quirna's production API. */
  baseUrl?: string;
  /** Per-request timeout. Default 30s. Not the time a human has to decide. */
  timeoutMs?: number;
  /** Extra attempts for a retryable failure on a GET. Default 2. */
  maxRetries?: number;
};

export type WaitOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  /** Abort the wait early — a disconnected caller, a shutting-down worker. */
  signal?: AbortSignal;
};

export type RequestOptions = {
  signal?: AbortSignal;
};

export class QuirnaError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    /** From a 429's `retry-after` header, when the server sent one. */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "QuirnaError";
  }
}

/** Kept in step with package.json by a test; sent as the User-Agent. */
export const VERSION = "0.1.0";

/**
 * Statuses worth trying again: a timeout, a rate limit, or a server/gateway
 * failure. Everything else (401, 403, 404, 422) means the request itself is
 * wrong and repeating it changes nothing.
 */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** Read an env var without assuming `process` exists (browsers, workers). */
function env(name: string): string | undefined {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.[name];
}

export class Quirna {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: QuirnaClientOptions) {
    // `options?.` because TypeScript makes `new Quirna()` a compile error but
    // JavaScript callers reach here with undefined, and a TypeError about
    // reading a property is a worse answer than saying what is missing.
    // An empty string is the shape a missing env var takes at the call site
    // (`process.env.QUIRNA_API_KEY ?? ""`), so it is caught here too rather
    // than becoming a 401 on the first request.
    if (!options?.apiKey) {
      throw new QuirnaError("missing API key: pass { apiKey }", 401, "missing_api_key");
    }
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? env("QUIRNA_BASE_URL") ?? DEFAULT_BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  get approvals() {
    return {
      create: (input: CreateApprovalInput, options?: RequestOptions) => this.create(input, options),
      get: (id: string, options?: RequestOptions) => this.get(id, options),
      wait: (id: string, options?: WaitOptions) => this.wait(id, options),
      require: (input: CreateApprovalInput, options?: WaitOptions) => this.require(input, options),
    };
  }

  async create(input: CreateApprovalInput, options?: RequestOptions): Promise<Approval> {
    return this.request<Approval>(
      "/v1/approvals",
      { method: "POST", body: JSON.stringify(input) },
      options,
    );
  }

  async get(id: string, options?: RequestOptions): Promise<Approval> {
    return this.request<Approval>(`/v1/approvals/${encodeURIComponent(id)}`, {}, options);
  }

  async wait(id: string, options: WaitOptions = {}): Promise<Approval> {
    const intervalMs = options.intervalMs ?? 2000;
    const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000;
    const started = Date.now();
    for (;;) {
      const approval = await this.get(id, { signal: options.signal });
      if (approval.status !== "pending") return approval;
      if (Date.now() - started >= timeoutMs) {
        throw new QuirnaError("wait timed out", 408, "wait_timeout");
      }
      const remaining = timeoutMs - (Date.now() - started);
      await sleep(Math.min(intervalMs, Math.max(remaining, 0)), options.signal);
    }
  }

  /**
   * Create a request and block until it is decided — `create` + `wait` in one
   * call. Returns immediately when a Policy auto-approved the request without
   * asking anyone.
   *
   * This holds the calling code for as long as it takes a human to answer (up
   * to `timeoutMs`, 15 minutes by default). Good for scripts, jobs and agents.
   * For a request with a user waiting on the other end, prefer `create` with a
   * `callback_url` and let the webhook resume the work.
   */
  async require(input: CreateApprovalInput, options?: WaitOptions): Promise<Approval> {
    const approval = await this.create(input, { signal: options?.signal });
    if (approval.status !== "pending") return approval;
    return this.wait(approval.id, options);
  }

  /**
   * One attempt, with a timeout and a defensively parsed body.
   *
   * The error body is not assumed to be JSON: a gateway in front of the API
   * answers a 502 with an HTML page, and `res.json()` would throw a
   * `SyntaxError` that has nothing to do with what went wrong.
   */
  private async send<T>(path: string, init: RequestInit, signal?: AbortSignal): Promise<T> {
    const link = linkSignals(this.timeoutMs, signal);
    let res: Response;
    try {
      res = await fetch(new URL(path, this.baseUrl), {
        ...init,
        signal: link.signal,
        headers: {
          "content-type": "application/json",
          "user-agent": `quirna-sdk/${VERSION}`,
          authorization: `Bearer ${this.apiKey}`,
          ...init.headers,
        },
      });
    } catch (err) {
      throw link.reasonFor(err);
    } finally {
      link.done();
    }

    const raw = await res.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch {
      parsed = {};
    }
    const body = parsed as { error?: string; code?: string };

    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new QuirnaError(
        body.error ?? `quirna request failed with ${res.status}`,
        res.status,
        body.code,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    return parsed as T;
  }

  /**
   * Send a request, retrying transient failures.
   *
   * Only GETs are retried. A POST may have reached the server and succeeded
   * before the connection broke, and `POST /v1/approvals` has no idempotency
   * key — repeating it would ask a human to approve the same thing twice.
   * Polling, which is where a blip actually hurts, is all GETs.
   */
  private async request<T>(
    path: string,
    init: RequestInit = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const idempotent = (init.method ?? "GET").toUpperCase() === "GET";
    const attempts = idempotent ? this.maxRetries + 1 : 1;

    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.send<T>(path, init, options.signal);
      } catch (err) {
        lastError = err;
        if (!isRetryable(err) || attempt === attempts - 1) throw err;
        await sleep(backoffMs(attempt, err), options.signal);
      }
    }
    throw lastError;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new QuirnaError("aborted", 499, "aborted");
}

function isRetryable(err: unknown): boolean {
  if (err instanceof QuirnaError) {
    if (err.code === "aborted" || err.code === "request_timeout") return false;
    return RETRYABLE_STATUSES.has(err.status);
  }
  // A transport-level failure — DNS, a reset connection, a dropped socket.
  // fetch throws a plain TypeError for all of them, with no status to read.
  return err instanceof TypeError;
}

/** Exponential backoff, jittered, but never earlier than a server's retry-after. */
function backoffMs(attempt: number, err: unknown): number {
  if (err instanceof QuirnaError && err.retryAfterSeconds !== undefined) {
    return err.retryAfterSeconds * 1000;
  }
  const base = Math.min(250 * 2 ** attempt, 2000);
  return base + Math.random() * base * 0.25;
}

/**
 * One signal that fires on the caller's abort or on our own timeout,
 * whichever comes first, plus the cleanup that keeps neither leaking.
 *
 * Built by hand rather than with `AbortSignal.any`, which is newer than the
 * runtimes this package claims to support.
 */
function linkSignals(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; done(): void; reasonFor(err: unknown): unknown } {
  const controller = new AbortController();
  let timedOut = false;

  const onAbort = () => controller.abort(abortReason(external));
  if (external?.aborted) onAbort();

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new QuirnaError("request timed out", 408, "request_timeout"));
  }, timeoutMs);
  external?.addEventListener("abort", onAbort, { once: true });

  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
    // fetch reports an abort as its own DOMException, losing the reason we
    // aborted with — so put ours back.
    reasonFor(err: unknown): unknown {
      if (!controller.signal.aborted) return err;
      if (timedOut) return new QuirnaError("request timed out", 408, "request_timeout");
      return abortReason(external);
    },
  };
}

export type Jwks = { keys: Jwk[] };

function defaultBaseUrl(): string {
  return env("QUIRNA_BASE_URL") ?? DEFAULT_BASE_URL;
}

export async function fetchJwks(baseUrl: string = defaultBaseUrl()): Promise<Jwks> {
  const res = await fetch(new URL("/v1/.well-known/jwks.json", baseUrl));
  if (!res.ok) throw new QuirnaError("failed to fetch JWKS", res.status);
  return (await res.json()) as Jwks;
}

/**
 * JWKS by base URL. Callbacks arrive one per decision, and the signing keys
 * change only on rotation, so fetching the set on every callback would be a
 * network round-trip per webhook for a value that is almost always identical.
 */
const jwksCache = new Map<string, Jwks>();

/** Resolve the JWKS for a base URL, refetching when `kid` isn't in the cache. */
async function jwksFor(baseUrl: string, kid: string): Promise<Jwks> {
  const cached = jwksCache.get(baseUrl);
  if (cached?.keys.some((k) => k.kid === kid)) return cached;
  // Either nothing cached, or a key we've never seen — which is what a
  // rotation looks like from here. Refetch before deciding it's unknown.
  const fresh = await fetchJwks(baseUrl);
  jwksCache.set(baseUrl, fresh);
  return fresh;
}

function header(headers: Headers, name: string): string | null {
  return headers.get(name) ?? headers.get(name.toLowerCase());
}

/** Decode base64url without `Buffer`, which only exists on Node and Bun. */
function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Verify a callback's signature and return its body, or throw.
 *
 * `jwksOrUrl` is an escape hatch — pass a base URL to verify against a
 * self-hosted or staging API, or a `Jwks` you already hold to skip the fetch
 * entirely (tests do this). Left out, it uses the same API the client does.
 */
export async function verifyCallback(
  rawBody: string,
  headers: Headers,
  jwksOrUrl?: Jwks | string,
): Promise<WebhookBody> {
  const timestamp = header(headers, WEBHOOK_HEADERS.timestamp);
  const eventId = header(headers, WEBHOOK_HEADERS.eventId);
  const kid = header(headers, WEBHOOK_HEADERS.keyId);
  const signature = header(headers, WEBHOOK_HEADERS.signature);
  if (!timestamp || !eventId || !kid || !signature) {
    throw new QuirnaError("missing quirna signature headers", 401, "missing_signature");
  }

  const ts = Date.parse(timestamp);
  if (Number.isNaN(ts) || Math.abs(Date.now() - ts) > TIMESTAMP_SKEW_MS) {
    throw new QuirnaError("callback timestamp outside allowed window", 401, "timestamp_skew");
  }

  const jwks =
    typeof jwksOrUrl === "object" ? jwksOrUrl : await jwksFor(jwksOrUrl ?? defaultBaseUrl(), kid);
  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (!jwk) {
    throw new QuirnaError("unknown signing key", 401, "unknown_key");
  }

  const key = await crypto.subtle.importKey("jwk", jwk, "Ed25519", true, ["verify"]);
  const ok = await crypto.subtle.verify(
    "Ed25519",
    key,
    base64UrlToBytes(signature),
    new TextEncoder().encode(`${timestamp}.${eventId}.${rawBody}`),
  );
  if (!ok) {
    throw new QuirnaError("invalid callback signature", 401, "bad_signature");
  }

  const body = JSON.parse(rawBody) as WebhookBody;
  if (body.event_id !== eventId) {
    throw new QuirnaError("event_id mismatch", 401, "event_mismatch");
  }
  if (body.timestamp !== timestamp) {
    throw new QuirnaError("timestamp mismatch", 401, "timestamp_mismatch");
  }
  return body;
}

export type {
  Approval,
  ApprovalStatus,
  CreateApprovalInput,
  DecisionValue,
  Identifiers,
  Jwk,
  PolicyPath,
  PolicyRequirement,
  PolicySnapshot,
  Tier,
  WebhookBody,
} from "./types";
// Re-exported by name, not with `export *`: this module imports several of
// these for its own use, and `export *` silently drops any name that is also
// bound locally — leaving consumers unable to import `Approval` at all.
export {
  APPROVAL_STATUSES,
  DECISIONS,
  TIERS,
  TIMESTAMP_SKEW_MS,
  WEBHOOK_HEADERS,
} from "./types";
