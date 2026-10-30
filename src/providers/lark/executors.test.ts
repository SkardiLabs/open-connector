import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { credentialValidators as feishuValidators, executors as feishuExecutors } from "../feishu/executors.ts";
import { createFeishuJsonRequest, requestFeishuMultipart, withFeishuRawResponse } from "../feishu/shared/client.ts";
import { feishuCloud, larkCloud } from "../feishu/shared/cloud.ts";
import { credentialValidators as larkValidators, executors as larkExecutors, proxy as larkProxy } from "./executors.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

const envelope = (data: Record<string, unknown>) => Response.json({ code: 0, msg: "ok", data });

function oauthCredential(): Extract<ResolvedCredential, { authType: "oauth2" }> {
  return {
    authType: "oauth2",
    accessToken: "u-token",
    tokenType: "Bearer",
    profile: { accountId: "ou_1", displayName: "User", grantedScopes: [] },
    metadata: {},
  };
}

/** Run one action and return every URL it fetched. */
async function fetchedUrls(
  executors: typeof larkExecutors,
  actionId: `${string}.${string}`,
  input: Record<string, unknown>,
): Promise<string[]> {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      urls.push(url.toString());
      return envelope({ open_id: "ou_1", name: "User", items: [], has_more: false });
    }),
  );
  const context: ExecutionContext = { getCredential: async () => oauthCredential() };
  const result = await executors[actionId]!(input, context);
  expect(result).toMatchObject({ ok: true });
  vi.unstubAllGlobals();
  return urls;
}

const cases: Array<[string, Record<string, unknown>, string]> = [
  // Native handler (feishu/runtime.ts).
  ["get_current_user", {}, "/open-apis/authen/v1/user_info"],
  // Shared handlers (feishu/shared/*, via createFeishuJsonRequest).
  ["list_drive_files", {}, "/open-apis/drive/v1/files"],
  ["list_chats", {}, "/open-apis/im/v1/chats"],
];

describe("Lark actions reuse Feishu handlers against Lark's API host", () => {
  for (const [name, input, path] of cases) {
    it(`lark.${name} goes to open.larksuite.com, feishu.${name} to open.feishu.cn`, async () => {
      const lark = await fetchedUrls(larkExecutors, `lark.${name}`, input);
      expect(lark.length).toBeGreaterThan(0);
      expect(lark.every((url) => url.startsWith(`https://open.larksuite.com${path}`))).toBe(true);

      const feishu = await fetchedUrls(feishuExecutors, `feishu.${name}`, input);
      expect(feishu.length).toBeGreaterThan(0);
      expect(feishu.every((url) => url.startsWith(`https://open.feishu.cn${path}`))).toBe(true);
    });
  }

  it("validates a Lark credential against Lark's user_info, a Feishu one against Feishu's", async () => {
    for (const [validators, host] of [
      [larkValidators, "open.larksuite.com"],
      [feishuValidators, "open.feishu.cn"],
    ] as const) {
      const urls: string[] = [];
      const result = await validators.oauth2!(oauthCredential(), {
        fetcher: async (url) => {
          urls.push(url.toString());
          return envelope({ open_id: "ou_1", name: "User", tenant_key: "t1" });
        },
      });
      expect(urls).toEqual([`https://${host}/open-apis/authen/v1/user_info`]);
      expect(result).toMatchObject({ profile: { accountId: "ou_1", displayName: "User" } });
    }
  });

  it("sends multipart uploads and raw downloads to the configured deployment", async () => {
    for (const cloud of [larkCloud, feishuCloud]) {
      const urls: string[] = [];
      const fetcher = (async (url: RequestInfo | URL) => {
        urls.push(url.toString());
        return envelope({ file_key: "k" });
      }) as typeof fetch;
      await requestFeishuMultipart({
        openBaseUrl: cloud.openBaseUrl,
        accessToken: "t",
        fetcher,
        path: "/im/v1/files",
        body: new FormData(),
      });
      await withFeishuRawResponse(
        { openBaseUrl: cloud.openBaseUrl, accessToken: "t", fetcher, path: "/drive/v1/files/x/download" },
        async () => undefined,
      );
      expect(urls).toEqual([`${cloud.openBaseUrl}/im/v1/files`, `${cloud.openBaseUrl}/drive/v1/files/x/download`]);
    }
  });
});

describe("Feishu and Lark quota errors", () => {
  it.each([200, 400, 429])(
    "keeps monthly quota exhaustion distinct on HTTP %i for native and shared actions",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          Response.json(
            { code: 99991403, msg: "This month's API call quota has been exceeded" },
            { status, headers: { "x-ogw-ratelimit-reset": "172800", "retry-after": "3" } },
          ),
        ),
      );
      const context: ExecutionContext = { getCredential: async () => oauthCredential() };
      for (const [service, executors] of [
        ["feishu", feishuExecutors],
        ["lark", larkExecutors],
      ] as const) {
        for (const name of ["get_current_user", "list_chats"]) {
          const result = await executors[`${service}.${name}`]!({}, context);
          expect(result).toMatchObject({
            ok: false,
            error: {
              code: "quota_exhausted",
              details: {
                status: 429,
                details: { providerStatus: status, providerCode: 99991403, retryAfterSeconds: 172800 },
              },
            },
          });
        }
      }
    },
  );

  it.each([
    [200, 99991400],
    [400, 99991400],
    [429, 0],
  ])("keeps short limits rate_limited on HTTP %i with code %i", async (status, code) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code, msg: "request trigger frequency limit" },
          { status, headers: { "x-ogw-ratelimit-reset": "73" } },
        ),
      ),
    );
    const context: ExecutionContext = { getCredential: async () => oauthCredential() };
    for (const name of ["get_current_user", "list_chats"]) {
      await expect(larkExecutors[`lark.${name}`]!({}, context)).resolves.toMatchObject({
        ok: false,
        error: { code: "rate_limited", details: { status: 429, details: { retryAfterSeconds: 73 } } },
      });
    }
  });

  it.each(["invalid", "0", "-1", "1.5", "Wed, 21 Oct 2026 07:28:00 GMT", "9007199254740992"])(
    "falls back to Retry-After for invalid gateway delay %s",
    async (reset) => {
      const request = createFeishuJsonRequest({
        openBaseUrl: larkCloud.openBaseUrl,
        accessToken: "t",
        fetcher: async () =>
          Response.json(
            { code: 99991403 },
            {
              status: 400,
              headers: { "x-ogw-ratelimit-reset": reset, "retry-after": "73" },
            },
          ),
      });
      await expect(request({ path: "/im/v1/chats" })).rejects.toMatchObject({
        code: "quota_exhausted",
        details: { retryAfterSeconds: 73 },
      });
    },
  );

  it("preserves a large gateway delay as seconds without interpreting it as a timestamp", async () => {
    const request = createFeishuJsonRequest({
      openBaseUrl: larkCloud.openBaseUrl,
      accessToken: "t",
      fetcher: async () =>
        Response.json(
          { code: 99991403 },
          {
            headers: { "x-ogw-ratelimit-reset": "1793491200" },
          },
        ),
    });
    await expect(request({ path: "/im/v1/chats" })).rejects.toMatchObject({
      code: "quota_exhausted",
      details: { retryAfterSeconds: 1793491200 },
    });
  });

  it("keeps quota exhaustion when the provider supplies no usable retry delay", async () => {
    const request = createFeishuJsonRequest({
      openBaseUrl: larkCloud.openBaseUrl,
      accessToken: "t",
      fetcher: async () =>
        Response.json(
          { code: 99991403 },
          {
            headers: { "x-ogw-ratelimit-reset": "invalid", "retry-after": "invalid" },
          },
        ),
    });
    await expect(request({ path: "/im/v1/chats" })).rejects.toMatchObject({
      status: 429,
      code: "quota_exhausted",
      details: { retryAfterSeconds: undefined },
    });
  });

  it("preserves quota pacing on multipart uploads and failed raw downloads", async () => {
    const input = {
      openBaseUrl: larkCloud.openBaseUrl,
      accessToken: "t",
      fetcher: async () =>
        Response.json(
          { code: 99991403 },
          {
            status: 400,
            headers: { "x-ogw-ratelimit-reset": "172800" },
          },
        ),
      path: "/im/v1/files",
    };
    await expect(requestFeishuMultipart({ ...input, body: new FormData() })).rejects.toMatchObject({
      code: "quota_exhausted",
      details: { retryAfterSeconds: 172800 },
    });
    await expect(withFeishuRawResponse(input, async () => undefined)).rejects.toMatchObject({
      code: "quota_exhausted",
      details: { retryAfterSeconds: 172800 },
    });
  });

  it.each([400, 429])("preserves quota pacing for a proxy HTTP %i response", async (status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          { code: 99991403 },
          {
            status,
            headers: { "x-ogw-ratelimit-reset": "172800" },
          },
        ),
      ),
    );
    await expect(
      larkProxy(
        { endpoint: "/im/v1/chats", method: "GET" },
        {
          getCredential: async () => oauthCredential(),
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "quota_exhausted", details: { status: 429, details: { retryAfterSeconds: 172800 } } },
    });
  });

  it("keeps a proxy's ordinary forbidden response an authorization failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ code: 99999999, msg: "Forbidden" }, { status: 403 })),
    );
    await expect(
      larkProxy(
        { endpoint: "/im/v1/chats", method: "GET" },
        {
          getCredential: async () => oauthCredential(),
        },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "authorization_failed", details: { status: 403 } },
    });
  });
});
