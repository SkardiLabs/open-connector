import { ProviderRequestError, readRetryAfterSeconds } from "../../provider-runtime.ts";

interface FeishuRateLimitInput {
  readonly response: Response;
  readonly providerCode: number | null;
  readonly message: string;
  readonly details: Record<string, unknown>;
}

const feishuRateLimitedErrorCodes = new Set([11232, 11233, 11247, 230020, 230047, 99991400, 1000004, 1000005]);

/** Keep monthly call exhaustion distinct from Feishu and Lark's short request limits. */
export function mapFeishuRateLimitError(input: FeishuRateLimitInput): ProviderRequestError | undefined {
  const quotaExhausted = input.providerCode === 99991403;
  if (
    !quotaExhausted &&
    input.response.status !== 429 &&
    (input.providerCode === null || !feishuRateLimitedErrorCodes.has(input.providerCode))
  ) {
    return undefined;
  }

  return new ProviderRequestError(
    429,
    input.message,
    { ...input.details, retryAfterSeconds: readFeishuRetryAfterSeconds(input.response.headers) },
    quotaExhausted ? "quota_exhausted" : "rate_limited",
  );
}

function readFeishuRetryAfterSeconds(headers: Headers): number | undefined {
  // Lark's gateway reports remaining recovery seconds, not an epoch or HTTP-date:
  // https://github.com/larksuite/cli/blob/main/internal/ratelimit/headers.go
  const reset = headers.get("x-ogw-ratelimit-reset")?.trim();
  if (reset && /^\d+$/.test(reset)) {
    const seconds = readRetryAfterSeconds(new Headers({ "retry-after": reset }));
    if (seconds !== undefined && seconds > 0) return seconds;
  }
  return readRetryAfterSeconds(headers);
}
