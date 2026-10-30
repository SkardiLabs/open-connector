import type { TransitFileWriter } from "../../../core/types.ts";

import { optionalRecord, optionalString } from "../../../core/cast.ts";
import {
  createProviderTimeout,
  ProviderRequestError,
  providerUserAgent,
  readProviderErrorTextBody,
} from "../../provider-runtime.ts";
import { mapFeishuRateLimitError } from "./rate-limit.ts";

export type FeishuIdentity = "user" | "tenant";

export type FeishuHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type FeishuQueryValue = string | readonly string[] | number | boolean | null | undefined;

export interface FeishuJsonRequestInput {
  readonly method?: FeishuHttpMethod;
  readonly path: string;
  readonly query?: Readonly<Record<string, FeishuQueryValue>> | readonly (readonly [string, string])[];
  readonly body?: unknown;
}

export interface FeishuJsonRequest {
  (input: FeishuJsonRequestInput): Promise<Record<string, unknown>>;
}

export interface FeishuActionRuntimeContext {
  /** Open Platform API base of the deployment this credential belongs to (see cloud.ts). */
  readonly openBaseUrl: string;
  readonly accessToken: string;
  readonly fetcher: typeof fetch;
  readonly identity: FeishuIdentity;
  readonly transitFiles?: TransitFileWriter;
  readonly signal?: AbortSignal;
}

export interface CreateFeishuJsonRequestInput extends Pick<
  FeishuActionRuntimeContext,
  "openBaseUrl" | "accessToken" | "fetcher" | "signal"
> {
  readonly phase?: "validate" | "execute";
}

export interface FeishuMultipartRequestInput {
  readonly openBaseUrl: string;
  readonly accessToken: string;
  readonly fetcher: typeof fetch;
  readonly path: string;
  readonly body: FormData;
  readonly signal?: AbortSignal;
}

export interface FeishuRawRequestInput {
  readonly openBaseUrl: string;
  readonly accessToken: string;
  readonly fetcher: typeof fetch;
  readonly path: string;
  readonly query?: FeishuJsonRequestInput["query"];
  readonly signal?: AbortSignal;
}

interface FeishuEnvelope {
  readonly code?: unknown;
  readonly msg?: unknown;
  readonly data?: unknown;
}

const feishuCredentialExpiredErrorCodes = new Set([
  4001, 10005, 10012, 10013, 10014, 10015, 20002, 20005, 20013, 20014, 99991543, 99991661, 99991663, 99991664, 99991665,
  99991668, 99991671, 99991677,
]);
const feishuScopeMissingErrorCodes = new Set([10023, 11223, 11229, 11241, 99991672, 99991676, 99991679]);

export function createFeishuJsonRequest(input: CreateFeishuJsonRequestInput): FeishuJsonRequest {
  return async (request) => {
    const url = new URL(`${input.openBaseUrl}${request.path}`);
    appendQuery(url, request.query);

    const timeout = createProviderTimeout(input.signal);
    try {
      const response = await input.fetcher(url, {
        method: request.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.accessToken}`,
          "content-type": "application/json; charset=utf-8",
          "user-agent": providerUserAgent,
        },
        body: request.body == null ? undefined : JSON.stringify(request.body),
        signal: timeout.signal,
      });
      const rawText = await response.text();
      const envelope = readFeishuEnvelope(rawText, request.path.startsWith("/okr/v2/"));
      const code = typeof envelope.code === "number" ? envelope.code : 0;
      if (!response.ok || code !== 0) {
        throw normalizeFeishuError({
          phase: input.phase ?? "execute",
          response,
          rawText,
          envelope,
        });
      }
      return normalizeFeishuData(envelope.data);
    } catch (error) {
      if (error instanceof ProviderRequestError) {
        throw error;
      }
      throw new ProviderRequestError(
        502,
        error instanceof Error ? `Feishu request failed: ${error.message}` : "Feishu request failed",
      );
    } finally {
      timeout.cleanup();
    }
  };
}

export async function requestFeishuMultipart(input: FeishuMultipartRequestInput): Promise<Record<string, unknown>> {
  const timeout = createProviderTimeout(input.signal);
  try {
    const response = await input.fetcher(`${input.openBaseUrl}${input.path}`, {
      method: "POST",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${input.accessToken}`,
        "user-agent": providerUserAgent,
      },
      body: input.body,
      signal: timeout.signal,
    });
    const rawText = await response.text();
    const envelope = readFeishuEnvelope(rawText);
    const code = typeof envelope.code === "number" ? envelope.code : 0;
    if (!response.ok || code !== 0) {
      throw normalizeFeishuError({
        phase: "execute",
        response,
        rawText,
        envelope,
      });
    }
    return normalizeFeishuData(envelope.data);
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `Feishu multipart request failed: ${error.message}` : "Feishu multipart request failed",
    );
  } finally {
    timeout.cleanup();
  }
}

export async function withFeishuRawResponse<T>(
  input: FeishuRawRequestInput,
  consume: (response: Response) => Promise<T>,
): Promise<T> {
  const url = new URL(`${input.openBaseUrl}${input.path}`);
  appendQuery(url, input.query);
  const timeout = createProviderTimeout(input.signal);
  try {
    const response = await input.fetcher(url, {
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "user-agent": providerUserAgent,
      },
      signal: timeout.signal,
    });
    if (!response.ok) {
      throw await readFeishuErrorResponse(response);
    }
    return await consume(response);
  } catch (error) {
    if (error instanceof ProviderRequestError) {
      throw error;
    }
    throw new ProviderRequestError(
      502,
      error instanceof Error ? `Feishu download failed: ${error.message}` : "Feishu download failed",
    );
  } finally {
    timeout.cleanup();
  }
}

/** Parse failed downloads and proxy requests through the same Feishu error mapping as actions. */
export async function readFeishuErrorResponse(response: Response): Promise<ProviderRequestError> {
  const rawText = await readProviderErrorTextBody(response, "Feishu error response");
  let envelope: FeishuEnvelope = {};
  try {
    envelope = readFeishuEnvelope(rawText);
  } catch {
    // Raw download endpoints may return a non-JSON error body.
  }
  return normalizeFeishuError({ phase: "execute", response, rawText, envelope });
}

function appendQuery(url: URL, query: FeishuJsonRequestInput["query"]) {
  if (!query) {
    return;
  }
  if (Array.isArray(query)) {
    for (const [key, value] of query) {
      url.searchParams.append(key, value);
    }
  } else {
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          url.searchParams.append(key, item);
        }
      } else if (value != null) {
        url.searchParams.set(key, String(value));
      }
    }
  }
}

function normalizeFeishuData(data: unknown): Record<string, unknown> {
  if (Array.isArray(data)) {
    return { items: data };
  }
  return optionalRecord(data) ?? {};
}

function readFeishuEnvelope(rawText: string, preserveNumericIds = false): FeishuEnvelope {
  if (!rawText) {
    return {};
  }
  try {
    const envelope = optionalRecord(JSON.parse(rawText, preserveNumericIds ? preserveOkrId : undefined) as unknown);
    if (envelope) {
      return envelope;
    }
  } catch {
    // Map malformed JSON to a Feishu response error below.
  }
  throw new ProviderRequestError(502, "invalid Feishu JSON response");
}

function preserveOkrId(key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value !== "number" || !Number.isInteger(value) || (key !== "id" && !key.endsWith("_id"))) return value;
  if (Number.isSafeInteger(value)) return String(value);
  if (!context?.source) throw new Error("Feishu OKR ID source is unavailable");
  return BigInt(context.source).toString();
}

function normalizeFeishuError(input: {
  readonly phase: "validate" | "execute";
  readonly response: Response;
  readonly rawText: string;
  readonly envelope: FeishuEnvelope;
}) {
  const status = input.response.status;
  const code = typeof input.envelope.code === "number" ? input.envelope.code : null;
  const providerMessage = optionalString(input.envelope.msg);
  const message = providerMessage ?? (input.rawText || `Feishu request failed with status ${status}`);
  const detailedMessage = code ? `Feishu ${code}: ${message}` : message;
  const errorData = {
    providerStatus: status,
    providerCode: code,
  };

  const rateLimitError = mapFeishuRateLimitError({
    response: input.response,
    providerCode: code,
    message: detailedMessage,
    details: errorData,
  });
  if (rateLimitError) return rateLimitError;
  if (input.phase === "validate") {
    if (status >= 500) {
      return new ProviderRequestError(502, detailedMessage, errorData);
    } else {
      return new ProviderRequestError(400, detailedMessage, errorData);
    }
  }
  if (code != null && feishuCredentialExpiredErrorCodes.has(code)) {
    return new ProviderRequestError(401, detailedMessage, errorData, "authorization_failed");
  }
  if (code != null && feishuScopeMissingErrorCodes.has(code)) {
    return new ProviderRequestError(403, detailedMessage, errorData);
  }
  if (status === 400 || status === 404 || status === 422 || code === 230001) {
    return new ProviderRequestError(status || 400, detailedMessage, errorData);
  }
  return new ProviderRequestError(status >= 400 ? status : 502, detailedMessage, errorData, "provider_error");
}
