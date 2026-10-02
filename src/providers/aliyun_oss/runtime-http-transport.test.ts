import type { ProviderHttpAttempt } from "../../core/provider-http-dispatch.ts";
import type { AliyunOssHttpClient, AliyunOssHttpResponse } from "./runtime-http-transport.ts";

import AliOss from "ali-oss";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { withProviderHttpDispatch } from "../../core/provider-http-dispatch.ts";
import { ProviderDispatchRequestError } from "../provider-runtime.ts";
import { executors } from "./executors.ts";
import { guardAliyunOssHttpClient } from "./runtime-http-transport.ts";

interface SdkClient extends AliyunOssHttpClient {
  listBuckets(): Promise<{ buckets: { name: string }[]; res: unknown }>;
}

const sdkOptions = {
  accessKeyId: "fixture-key",
  accessKeySecret: "fixture-secret",
  endpoint: "oss-cn-hangzhou.aliyuncs.com",
  secure: true,
};
const context = {
  operation: "action",
  service: "aliyun_oss",
  actionId: "aliyun_oss.list_buckets",
  connectionId: "oss-connection",
} as const;
const bucketXml =
  "<ListAllMyBucketsResult><Owner><ID>account</ID><DisplayName>Account</DisplayName></Owner><Buckets><Bucket><Name>documents</Name><Location>oss-cn-hangzhou</Location></Bucket></Buckets><IsTruncated>false</IsTruncated></ListAllMyBucketsResult>";

function result(data: unknown = Buffer.from(bucketXml)): AliyunOssHttpResponse {
  const headers = { "x-oss-request-id": "request-1", etag: "fixture-etag" };
  return { status: 200, headers, data, res: { statusCode: 200, headers } };
}

afterEach(() => {
  vi.restoreAllMocks();
  setDefaultGuardedFetchDnsLookup(null);
});

describe("Alibaba Cloud OSS HTTP dispatch bridge", () => {
  it("never treats SDK metadata as EOF, even when its synthetic response describes HEAD or 204", async () => {
    for (const [method, status] of [
      ["HEAD", 200],
      ["GET", 204],
    ] as const) {
      const response = { ...result(), status };
      const client: AliyunOssHttpClient = {
        urllib: { request: vi.fn().mockResolvedValue(response) },
        requestError: async (error) => error,
      };
      guardAliyunOssHttpClient(client);
      const onBodyEnd = vi.fn();
      const onResult = vi.fn();
      expect(
        await withProviderHttpDispatch(
          context,
          () => client.urllib.request("https://oss-cn-hangzhou.aliyuncs.com/path", { method }),
          {
            beforeAttempt: () => ({ allow: true, onResult, onBodyEnd }),
          },
        ),
      ).toBe(response);
      expect(onResult).toHaveBeenCalledExactlyOnceWith({ kind: "response", status, retryAfter: undefined });
      expect(onBodyEnd).toHaveBeenCalledExactlyOnceWith({ kind: "unknown" });
    }
  });

  it("preserves the SDK's exact buffered and streaming request/response objects", async () => {
    const stream = Readable.from([Buffer.from("streamed content")]);
    const response = { ...result(), res: stream };
    const request = vi.fn().mockResolvedValue(response);
    const client: AliyunOssHttpClient = { urllib: { request }, requestError: async (error) => error };
    const content = Buffer.from([0, 255, 1]);
    const headers = { authorization: "signed-secret", "content-md5": "signed-digest" };
    const onResult = vi.fn();
    const attempts: ProviderHttpAttempt[] = [];
    guardAliyunOssHttpClient(client);
    const returned = await withProviderHttpDispatch(
      context,
      () =>
        client.urllib.request("https://oss-cn-hangzhou.aliyuncs.com/path", {
          method: "PUT",
          headers,
          content,
          stream,
          customResponse: true,
          timeout: 60123,
        }),
      {
        beforeAttempt: (attempt) => {
          attempts.push(attempt);
          return { allow: true, onResult };
        },
      },
    );
    expect(returned).toBe(response);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      method: "PUT",
      timeout: 60123,
      customResponse: true,
      followRedirect: false,
    });
    expect(request.mock.calls[0]?.[1].headers).toBe(headers);
    expect(request.mock.calls[0]?.[1].content).toBe(content);
    expect(request.mock.calls[0]?.[1].stream).toBe(stream);
    expect(returned.res).toBe(stream);
    expect(stream.readableDidRead).toBe(false);
    expect(onResult).toHaveBeenCalledExactlyOnceWith({ kind: "response", status: 200, retryAfter: undefined });
    expect(JSON.stringify(attempts)).not.toContain("signed-secret");
  });

  it("preserves real executor signing and XML response mapping through the SDK", async () => {
    const probe = new AliOss(sdkOptions) as unknown as SdkClient;
    const request = vi.spyOn(probe.urllib, "request").mockResolvedValue(result());
    const beforeAttempt = vi.fn((_attempt: ProviderHttpAttempt) => ({ allow: true as const }));
    const executed = await withProviderHttpDispatch(
      context,
      () =>
        executors["aliyun_oss.list_buckets"]!(
          {},
          {
            getCredential: async () => ({
              authType: "custom_credential",
              values: { ...sdkOptions, endpoint: sdkOptions.endpoint, secure: "true" } as unknown as Record<
                string,
                string
              >,
              profile: { accountId: "account", displayName: "Account", grantedScopes: [] },
              metadata: {},
            }),
          },
        ),
      { beforeAttempt },
    );
    expect(executed).toMatchObject({
      ok: true,
      output: { buckets: [{ name: "documents", region: "oss-cn-hangzhou" }], owner: { id: "account" } },
    });
    expect(request).toHaveBeenCalledOnce();
    const args = request.mock.calls[0]![1];
    const headers = args.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^OSS fixture-key:/);
    expect(headers["x-oss-date"]).toBeDefined();
    expect(args.followRedirect).toBe(false);
    expect(beforeAttempt).toHaveBeenCalledOnce();
    expect(JSON.stringify(beforeAttempt.mock.calls)).not.toContain("fixture-secret");
  });

  it("admits each real SDK internal retry and preserves urllib network errors", async () => {
    const networkError = Object.assign(new Error("network failure"), { status: -1 });
    const response = result();
    const request = vi.fn().mockRejectedValueOnce(networkError).mockResolvedValueOnce(response);
    const options = { ...sdkOptions, retryMax: 1, urllib: { request } };
    const client = new AliOss(options) as unknown as SdkClient;
    guardAliyunOssHttpClient(client);
    const beforeAttempt = vi.fn((_attempt: ProviderHttpAttempt) => ({ allow: true as const, onResult }));
    const onResult = vi.fn();
    const returned = await withProviderHttpDispatch(context, () => client.listBuckets(), { beforeAttempt });
    expect(returned.buckets).toMatchObject([{ name: "documents" }]);
    expect(returned.res).toBe(response.res);
    expect(request).toHaveBeenCalledTimes(2);
    expect(beforeAttempt).toHaveBeenCalledTimes(2);
    expect(onResult.mock.calls.map(([feedback]) => feedback.kind)).toEqual(["transport_error", "response"]);
    expect(beforeAttempt.mock.calls[0]?.[0].requestId).not.toBe(beforeAttempt.mock.calls[1]?.[0].requestId);
  });

  it("preserves retryable denial and its Retry-After through the SDK error mapper", async () => {
    const request = vi.fn();
    const options = { ...sdkOptions, retryMax: 2, urllib: { request } };
    const client = new AliOss(options) as unknown as SdkClient;
    guardAliyunOssHttpClient(client);
    const pending = withProviderHttpDispatch(context, () => client.listBuckets(), {
      beforeAttempt: () => ({ allow: false, retryAfterSeconds: 73 }),
    });
    await expect(pending).rejects.toBeInstanceOf(ProviderDispatchRequestError);
    await expect(pending).rejects.toMatchObject({
      status: 429,
      code: "rate_limited",
      details: { retryAfterSeconds: 73 },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("guards the actual SDK bucket host before the hook or raw transport runs", async () => {
    setDefaultGuardedFetchDnsLookup(async () => [{ address: "127.0.0.1", family: 4 }]);
    const request = vi.fn();
    const client: AliyunOssHttpClient = { urllib: { request }, requestError: async (error) => error };
    guardAliyunOssHttpClient(client);
    const beforeAttempt = vi.fn(() => ({ allow: true as const }));
    await expect(
      withProviderHttpDispatch(
        context,
        () => client.urllib.request("https://bucket.oss-cn-hangzhou.aliyuncs.com/path", { method: "GET" }),
        { beforeAttempt },
      ),
    ).rejects.toThrow("private or reserved");
    expect(request).not.toHaveBeenCalled();
    expect(beforeAttempt).not.toHaveBeenCalled();
  });

  it("keeps the original SDK transport when no dispatch hook is configured", async () => {
    const probe = new AliOss(sdkOptions) as unknown as SdkClient;
    const request = vi.spyOn(probe.urllib, "request").mockResolvedValue(result());
    const executed = await executors["aliyun_oss.list_buckets"]!(
      {},
      {
        getCredential: async () => ({
          authType: "custom_credential",
          values: { accessKeyId: "fixture-key", accessKeySecret: "fixture-secret", endpoint: sdkOptions.endpoint },
          profile: { accountId: "account", displayName: "Account", grantedScopes: [] },
          metadata: {},
        }),
      },
    );
    expect(executed.ok).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1].followRedirect).toBeUndefined();
  });
});
