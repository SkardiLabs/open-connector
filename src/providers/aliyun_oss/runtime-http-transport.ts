import { isPrivateNetworkAccessAllowed } from "../../core/request.ts";
import { createProviderFetch, ProviderDispatchRequestError } from "../provider-runtime.ts";

/** The ali-oss client delegates each SDK attempt to this injectable urllib contract. */
export interface AliyunOssHttpTransport {
  request(url: string, options: AliyunOssHttpRequestOptions): Promise<AliyunOssHttpResponse>;
}

export interface AliyunOssHttpRequestOptions {
  method?: string;
  followRedirect?: boolean;
  [name: string]: unknown;
}

export interface AliyunOssHttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  [name: string]: unknown;
}

export interface AliyunOssHttpClient {
  urllib: AliyunOssHttpTransport;
  requestError(result: unknown): Promise<unknown>;
}

/**
 * Guard and admit the SDK's existing transport without translating its signed
 * requests, bodies, streams, responses or timeout errors. Native redirect
 * following is disabled; ali-oss already treats a surfaced 3xx as an error.
 */
export function guardAliyunOssHttpClient(client: AliyunOssHttpClient, signal?: AbortSignal): void {
  const base = client.urllib;
  client.urllib = {
    async request(url, options): Promise<AliyunOssHttpResponse> {
      let result: AliyunOssHttpResponse | undefined;
      const fetcher = createProviderFetch({
        responseObservation: "metadata_only",
        allowPrivateNetwork: isPrivateNetworkAccessAllowed,
        fetch: async () => {
          result = await base.request(url, { ...options, followRedirect: false });
          // This metadata-only response lets the shared seam report status and
          // Retry-After. The original SDK body/stream is never read or replaced.
          const headers = new Headers();
          const retryAfter = result.headers["retry-after"];
          if (typeof retryAfter === "string") headers.set("retry-after", retryAfter);
          return new Response(null, { status: result.status, headers });
        },
      });
      await fetcher(url, { method: options.method, redirect: "manual", signal });
      return result!;
    },
  };
  const requestError = client.requestError;
  client.requestError = async function (result: unknown): Promise<unknown> {
    // The SDK otherwise discards a thrown dispatch denial's typed code and pacing hint.
    if (result instanceof ProviderDispatchRequestError) return result;
    return requestError.call(this, result);
  };
}
