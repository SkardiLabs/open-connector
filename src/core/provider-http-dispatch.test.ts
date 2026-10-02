import type { ProviderHttpAttempt, ProviderHttpPermit } from "./provider-http-dispatch.ts";

import { afterEach, describe, expect, it, vi } from "vitest";
import { lacunaActionHandlers, skipRetryDelay } from "../providers/lacuna/runtime.ts";
import { createProviderFetch, providerFetch, toProviderExecutionError } from "../providers/provider-runtime.ts";
import { createGuardedFetch } from "./guarded-fetch.ts";
import { withProviderHttpDispatch } from "./provider-http-dispatch.ts";

afterEach(() => vi.unstubAllGlobals());

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const context = {
  operation: "action",
  service: "example",
  actionId: "example.read",
  connectionId: "connection-1",
} as const;

describe("provider HTTP dispatch", () => {
  it("preserves unset behavior and passes the original transport response through", async () => {
    const response = new Response("ok");
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
    const fetcher = createProviderFetch({ fetch: transport });
    expect(await fetcher("https://example.com")).toBe(response);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("awaits admission before sending and reports the response without consuming it", async () => {
    const gate = deferred<ProviderHttpPermit>();
    const response = new Response("private response", {
      status: 429,
      headers: { "Retry-After": "37", "Set-Cookie": "secret" },
    });
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
    const onDispatch = vi.fn();
    const onResult = vi.fn();
    const beforeAttempt = vi.fn(() => gate.promise);
    const pending = withProviderHttpDispatch(
      context,
      () => createProviderFetch({ fetch: transport })("https://example.com"),
      { beforeAttempt },
    );
    await vi.waitFor(() => expect(beforeAttempt).toHaveBeenCalledOnce());
    expect(transport).not.toHaveBeenCalled();
    gate.resolve({ allow: true, onDispatch, onResult });
    expect(await pending).toBe(response);
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledExactlyOnceWith({ kind: "response", status: 429, retryAfter: "37" });
    expect(response.bodyUsed).toBe(false);
  });

  it("maps denial to rate_limited with a Retry-After hint and sends no request", async () => {
    const transport = vi.fn<typeof fetch>();
    const failure = await withProviderHttpDispatch(
      context,
      () => createProviderFetch({ fetch: transport })("https://example.com"),
      {
        beforeAttempt: () => ({ allow: false, retryAfterSeconds: 91 }),
      },
    ).catch((error: unknown) => toProviderExecutionError(error, "failed"));
    expect(failure).toMatchObject({
      ok: false,
      error: { code: "rate_limited", details: { status: 429, details: { retryAfterSeconds: 91 } } },
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["bind", "admission", "dispatch"])("fails closed when the %s hook throws", async (phase) => {
    const transport = vi.fn<typeof fetch>();
    const onResult = vi.fn();
    const fail = (): never => {
      throw new Error("credential-secret");
    };
    const pending = withProviderHttpDispatch(
      context,
      () => createProviderFetch({ fetch: transport })("https://example.com"),
      {
        bindAuthority: phase === "bind" ? fail : undefined,
        beforeAttempt:
          phase === "admission"
            ? fail
            : () => ({ allow: true, onDispatch: phase === "dispatch" ? fail : undefined, onResult }),
      },
    );
    await expect(pending).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    await expect(pending).rejects.not.toThrow("credential-secret");
    expect(transport).not.toHaveBeenCalled();
    if (phase === "dispatch")
      expect(onResult).toHaveBeenCalledExactlyOnceWith({ kind: "not_dispatched", reason: "dispatch_failed" });
  });

  it("admits every redirect hop with its actual origin and rewritten method", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 303, headers: { location: "https://other.example/new?token=secret" } }),
      )
      .mockResolvedValueOnce(new Response("ok"));
    const attempts: ProviderHttpAttempt[] = [];
    const onResult = vi.fn();
    await withProviderHttpDispatch(
      context,
      () =>
        createProviderFetch({ fetch: transport })("https://example.com/private", { method: "POST", body: "secret" }),
      {
        beforeAttempt: (attempt) => {
          attempts.push(attempt);
          return { allow: true, onResult };
        },
      },
    );
    expect(attempts.map(({ origin, method, redirectHop }) => ({ origin, method, redirectHop }))).toEqual([
      { origin: "https://example.com", method: "POST", redirectHop: 0 },
      { origin: "https://other.example", method: "GET", redirectHop: 1 },
    ]);
    expect(attempts[0]?.requestId).toBe(attempts[1]?.requestId);
    expect(attempts[0]?.attemptId).not.toBe(attempts[1]?.attemptId);
    expect(onResult).toHaveBeenCalledTimes(2);
  });

  it("can deny a redirect hop after the first response", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: "https://other.example" } }));
    await expect(
      withProviderHttpDispatch(context, () => createProviderFetch({ fetch: transport })("https://example.com"), {
        beforeAttempt: (attempt) => ({ allow: attempt.redirectHop === 0 }),
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(transport).toHaveBeenCalledOnce();
  });

  it("snapshots a manual request target and method before delayed admission", async () => {
    const url = new URL("https://example.com/private");
    const init: RequestInit = { method: "GET", redirect: "manual" };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    await withProviderHttpDispatch(context, () => createProviderFetch({ fetch: transport })(url, init), {
      beforeAttempt: async () => {
        url.href = "http://127.0.0.1/private";
        init.method = "DELETE";
        return { allow: true };
      },
    });
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      "https://example.com/private",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("admits every real provider-internal retry", async () => {
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ results: [] }));
    const beforeAttempt = vi.fn((_attempt: ProviderHttpAttempt) => ({ allow: true as const }));
    await withProviderHttpDispatch(
      { ...context, service: "lacuna", actionId: "lacuna.search" },
      () =>
        lacunaActionHandlers.search(
          { query: "test" },
          { fetcher: createProviderFetch({ fetch: transport }), sleep: skipRetryDelay },
        ),
      { beforeAttempt },
    );
    expect(beforeAttempt).toHaveBeenCalledTimes(3);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(new Set(beforeAttempt.mock.calls.map(([attempt]) => attempt.requestId)).size).toBe(3);
  });

  it("retains scope through module-level and rewrapped fetchers", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", transport);
    const rewrapped = createProviderFetch({ fetch: providerFetch, skipDnsValidation: true });
    const customPolicy = createGuardedFetch({ fetch: providerFetch, skipDnsValidation: true });
    const beforeAttempt = vi.fn(() => ({ allow: true as const }));
    await withProviderHttpDispatch(
      context,
      async () => {
        await providerFetch("https://example.com");
        await rewrapped("https://example.com");
        await customPolicy("https://example.com");
      },
      { beforeAttempt },
    );
    expect(beforeAttempt).toHaveBeenCalledTimes(3);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it("rejects blocked initial and redirect URLs before admission", async () => {
    const beforeAttempt = vi.fn(() => ({ allow: true as const }));
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }));
    await withProviderHttpDispatch(
      context,
      async () => {
        await expect(createProviderFetch({ fetch: transport })("http://127.0.0.1")).rejects.toThrow();
        expect(beforeAttempt).not.toHaveBeenCalled();
        await expect(createProviderFetch({ fetch: transport })("https://example.com")).rejects.toThrow();
      },
      { beforeAttempt },
    );
    expect(beforeAttempt).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("revalidates DNS after delayed admission", async () => {
    let address = "93.184.216.34";
    const transport = vi.fn<typeof fetch>();
    const onResult = vi.fn();
    const fetcher = createGuardedFetch({
      fetch: transport,
      lookup: async () => [{ address, family: 4 }],
      dispatchAttempt: async (...args) => {
        const { dispatchProviderHttpAttempt } = await import("./provider-http-dispatch.ts");
        return dispatchProviderHttpAttempt(...args);
      },
    });
    await expect(
      withProviderHttpDispatch(context, () => fetcher("https://example.com"), {
        beforeAttempt: () => {
          address = "127.0.0.1";
          return { allow: true, onResult };
        },
      }),
    ).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledExactlyOnceWith({ kind: "not_dispatched", reason: "dispatch_failed" });
  });

  it("cancels a queued attempt promptly and accounts for a late permit", async () => {
    const controller = new AbortController();
    const gate = deferred<ProviderHttpPermit>();
    const transport = vi.fn<typeof fetch>();
    const onResult = vi.fn();
    const beforeAttempt = vi.fn(() => gate.promise);
    const pending = withProviderHttpDispatch(
      context,
      () => createProviderFetch({ fetch: transport })("https://example.com", { signal: controller.signal }),
      { beforeAttempt },
    );
    await vi.waitFor(() => expect(beforeAttempt).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    gate.resolve({ allow: true, onResult });
    await vi.waitFor(() =>
      expect(onResult).toHaveBeenCalledExactlyOnceWith({ kind: "not_dispatched", reason: "cancelled" }),
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("reports an uncertain transport failure without leaking its raw error", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("secret-url-and-headers"));
    const onResult = vi.fn();
    await expect(
      withProviderHttpDispatch(context, () => createProviderFetch({ fetch: transport })("https://example.com"), {
        beforeAttempt: () => ({ allow: true, onResult }),
      }),
    ).rejects.toThrow();
    expect(onResult).toHaveBeenCalledExactlyOnceWith({ kind: "transport_error" });
  });

  it("preserves a successful response when feedback fails", async () => {
    const response = new Response("ok");
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response);
    const onFeedbackError = vi.fn(() => {
      throw new Error("observer failed");
    });
    expect(
      await withProviderHttpDispatch(context, () => createProviderFetch({ fetch: transport })("https://example.com"), {
        beforeAttempt: () => ({
          allow: true,
          onResult: () => {
            throw new Error("durability failed");
          },
        }),
        onFeedbackError,
      }),
    ).toBe(response);
    expect(onFeedbackError).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("freezes allowlisted context and authority without exposing credential-bearing request data", async () => {
    const attempts: ProviderHttpAttempt[] = [];
    const inputContext = { ...context, secret: "context-secret" };
    const authority = { workspaceId: "workspace-1", connectionLineageId: "lineage-1", token: "authority-secret" };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    await withProviderHttpDispatch(
      inputContext,
      () =>
        createProviderFetch({ fetch: transport })(
          "https://example.com/private-secret?token=query-secret#fragment-secret",
          { headers: { authorization: "header-secret" }, method: "POST", body: "body-secret" },
        ),
      {
        bindAuthority: () => authority,
        beforeAttempt: (attempt) => {
          attempts.push(attempt);
          return { allow: true };
        },
      },
    );
    const attempt = attempts[0]!;
    expect(JSON.stringify(attempt)).not.toContain("secret");
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(Object.isFrozen(attempt.context)).toBe(true);
    expect(Object.isFrozen(attempt.authority)).toBe(true);
    authority.workspaceId = "changed";
    expect(attempt.authority.workspaceId).toBe("workspace-1");
  });

  it("isolates concurrent work and restores its parent scope", async () => {
    const gate = deferred<void>();
    const attempts: ProviderHttpAttempt[] = [];
    const fetcher = createProviderFetch({
      fetch: vi.fn<typeof fetch>().mockImplementation(async () => new Response("ok")),
    });
    const options = {
      beforeAttempt: (attempt: ProviderHttpAttempt) => {
        attempts.push(attempt);
        return { allow: true as const };
      },
    };
    await withProviderHttpDispatch(
      context,
      async () => {
        await Promise.all([
          withProviderHttpDispatch({ ...context, connectionId: "first" }, async () => {
            await gate.promise;
            await fetcher("https://example.com");
          }),
          withProviderHttpDispatch({ ...context, connectionId: "second" }, async () => {
            await fetcher("https://example.com");
            gate.resolve();
          }),
        ]);
        await fetcher("https://example.com");
      },
      options,
    );
    expect(attempts.map((attempt) => attempt.context.connectionId)).toEqual(["second", "first", "connection-1"]);
    await fetcher("https://example.com");
    expect(attempts).toHaveLength(3);
  });
});
