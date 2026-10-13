/**
 * Pacing for Gmail's per-user rate limit.
 *
 * Gmail meters every user at a moving-average quota (messages.get costs 5 of
 * roughly 250 units per second), so a listing that hydrates each message in
 * parallel bursts past it after a few pages. Google answers with 429, or with
 * 403 and a `rateLimitExceeded` / `userRateLimitExceeded` reason, and asks
 * callers to back off exponentially. Failing the whole action on the first
 * one throws away a page of already-fetched messages and leaves the caller to
 * retry within milliseconds, which only extends the throttle.
 *
 * One limiter lives for one action call. A throttled response pauses every
 * request of that call, not only the one that saw it, because the quota is
 * per user: the other in-flight hydrations would be refused for the same
 * reason. Only GET and HEAD are retried, since a refused write is not
 * guaranteed to have had no effect. The whole call stops retrying at a fixed
 * budget so it answers well inside its caller's request timeout; the last
 * throttled response is then returned unchanged and surfaces as `rate_limited`.
 */

export interface GmailRateLimitOptions {
  /** Total time one action may spend waiting out throttles, in milliseconds. */
  budgetMs?: number;
  /** First backoff when Google gives no Retry-After, in milliseconds. */
  baseDelayMs?: number;
  /** Ceiling on any single wait, Retry-After included, in milliseconds. */
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

const defaultBudgetMs = 20_000;
const defaultBaseDelayMs = 1_000;
const defaultMaxDelayMs = 8_000;
const rateLimitReasons = new Set(["rateLimitExceeded", "userRateLimitExceeded"]);

/**
 * Wraps a fetcher so Gmail rate-limit responses are waited out and retried
 * within one action call's budget.
 */
export function createGmailRateLimitedFetch(fetcher: typeof fetch, options: GmailRateLimitOptions = {}): typeof fetch {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const baseDelayMs = options.baseDelayMs ?? defaultBaseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? defaultMaxDelayMs;
  const deadline = now() + (options.budgetMs ?? defaultBudgetMs);
  let pausedUntil = 0;
  let streak = 0;

  return async function gmailRateLimitedFetch(input, init) {
    const retryable = isRetryableMethod(init?.method ?? (input instanceof Request ? input.method : undefined));
    for (;;) {
      const wait = pausedUntil - now();
      if (wait > 0) {
        await sleep(wait);
      }
      const response = await fetcher(input, init);
      if (!retryable || !(await isRateLimited(response))) {
        if (response.ok) {
          streak = 0;
        }
        return response;
      }
      streak += 1;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (streak - 1));
      const delay = Math.min(maxDelayMs, readRetryAfterMs(response, now()) ?? backoff * (0.5 + random() / 2));
      const resumeAt = Math.max(pausedUntil, now() + delay);
      if (resumeAt > deadline) {
        return response;
      }
      pausedUntil = resumeAt;
      await response.body?.cancel().catch(() => undefined);
    }
  };
}

function isRetryableMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized === "GET" || normalized === "HEAD";
}

async function isRateLimited(response: Response): Promise<boolean> {
  if (response.status === 429) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  const text = await response
    .clone()
    .text()
    .catch(() => "");
  try {
    const payload = JSON.parse(text) as { error?: { errors?: Array<{ reason?: unknown }> } };
    return (payload.error?.errors ?? []).some(
      (entry) => typeof entry.reason === "string" && rateLimitReasons.has(entry.reason),
    );
  } catch {
    return false;
  }
}

function readRetryAfterMs(response: Response, nowMs: number): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
