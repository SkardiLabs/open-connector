import { describe, expect, it, vi } from "vitest";
import { observeProviderResponseBody } from "./provider-response-body.ts";
import { readBoundedResponseBytes } from "./request.ts";

describe("provider response body completion observer", () => {
  it("reads lazily one chunk per demand without teeing or eager buffering", async () => {
    let pulls = 0;
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const chunk = chunks[pulls++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const onBodyEnd = vi.fn();
    const response = await observeProviderResponseBody(new Response(source), {
      method: "GET",
      observation: "body",
      onBodyEnd,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls).toBe(0);
    expect(onBodyEnd).not.toHaveBeenCalled();
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toBe(chunks[0]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(pulls).toBe(1);
    expect(onBodyEnd).not.toHaveBeenCalled();
    expect((await reader.read()).value).toBe(chunks[1]);
    expect((await reader.read()).done).toBe(true);
    expect(pulls).toBe(3);
    expect(onBodyEnd).toHaveBeenCalledExactlyOnceWith({ kind: "eof" });
  });

  it("preserves response metadata and native JSON/clone consumption with one upstream EOF", async () => {
    const original = Response.json({ result: "fixture" }, { headers: { "x-fixture": "value" }, statusText: "Fixture" });
    Object.defineProperties(original, {
      url: { value: "https://provider.example/final" },
      type: { value: "basic" },
      redirected: { value: true },
    });
    const onBodyEnd = vi.fn();
    const response = await observeProviderResponseBody(original, { method: "GET", observation: "body", onBodyEnd });
    const clone = response.clone();
    for (const result of [response, clone, clone.clone()]) {
      expect(result.status).toBe(200);
      expect(result.statusText).toBe("Fixture");
      expect(result.headers.get("x-fixture")).toBe("value");
      expect(result.url).toBe(original.url);
      expect(result.type).toBe("basic");
      expect(result.redirected).toBe(true);
      expect(result.bodyUsed).toBe(false);
    }
    expect(await clone.json()).toEqual({ result: "fixture" });
    expect(await response.json()).toEqual({ result: "fixture" });
    expect(onBodyEnd).toHaveBeenCalledExactlyOnceWith({ kind: "eof" });
    expect(response.bodyUsed).toBe(true);
    expect(() => response.clone()).toThrow();
  });

  it("does not turn cancellation of one cloned branch into premature completion", async () => {
    const onBodyEnd = vi.fn();
    const response = await observeProviderResponseBody(new Response("fixture"), {
      method: "GET",
      observation: "body",
      onBodyEnd,
    });
    const clone = response.clone();
    const cancelled = clone.body!.cancel();
    expect(onBodyEnd).not.toHaveBeenCalled();
    expect(await response.text()).toBe("fixture");
    await cancelled;
    expect(onBodyEnd).toHaveBeenCalledExactlyOnceWith({ kind: "eof" });
  });

  it("reports cancellation and stream errors as unknown while preserving native errors", async () => {
    const onBodyEnd = vi.fn();
    const cancel = vi.fn();
    const response = await observeProviderResponseBody(new Response(new ReadableStream({ cancel })), {
      method: "GET",
      observation: "body",
      onBodyEnd,
    });
    await response.body!.cancel("fixture-cancel");
    expect(cancel).toHaveBeenCalledExactlyOnceWith("fixture-cancel");
    expect(onBodyEnd).toHaveBeenCalledExactlyOnceWith({ kind: "unknown" });

    const networkError = new Error("Original body stream failure");
    const onErrorEnd = vi.fn();
    const failed = await observeProviderResponseBody(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(networkError);
          },
        }),
      ),
      { method: "GET", observation: "body", onBodyEnd: onErrorEnd },
    );
    await expect(failed.text()).rejects.toBe(networkError);
    expect(onErrorEnd).toHaveBeenCalledExactlyOnceWith({ kind: "unknown" });
  });

  it("keeps a pending read cancelled without converting its close into EOF", async () => {
    const cancel = vi.fn();
    const onBodyEnd = vi.fn();
    const response = await observeProviderResponseBody(new Response(new ReadableStream({ cancel })), {
      method: "GET",
      observation: "body",
      onBodyEnd,
    });
    const reader = response.body!.getReader();
    const pending = reader.read();
    await new Promise((resolve) => setImmediate(resolve));
    await reader.cancel("pending-cancel");
    expect((await pending).done).toBe(true);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("pending-cancel");
    expect(onBodyEnd).toHaveBeenCalledExactlyOnceWith({ kind: "unknown" });
  });

  it("starts native cancellation before pending feedback and preserves native cancel failures", async () => {
    let finishFeedback!: () => void;
    const cancel = vi.fn();
    const response = await observeProviderResponseBody(new Response(new ReadableStream({ cancel })), {
      method: "GET",
      observation: "body",
      onBodyEnd: () =>
        new Promise<void>((resolve) => {
          finishFeedback = resolve;
        }),
    });
    const pending = response.body!.cancel("fixture");
    expect(cancel).toHaveBeenCalledExactlyOnceWith("fixture");
    let returned = false;
    void pending.then(() => {
      returned = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(returned).toBe(true);
    await pending;
    finishFeedback();

    const error = new Error("Original cancel failure");
    const failed = await observeProviderResponseBody(
      new Response(
        new ReadableStream({
          cancel() {
            throw error;
          },
        }),
      ),
      {
        method: "GET",
        observation: "body",
        onBodyEnd() {
          throw new Error("Host receipt failure");
        },
      },
    );
    await expect(failed.body!.cancel()).rejects.toBe(error);
  });

  it("reports unknown once when both native cloned branches cancel", async () => {
    const cancel = vi.fn();
    const onBodyEnd = vi.fn();
    const response = await observeProviderResponseBody(new Response(new ReadableStream({ cancel })), {
      method: "GET",
      observation: "body",
      onBodyEnd,
    });
    const clone = response.clone();
    await Promise.all([response.body!.cancel("original-cancel"), clone.body!.cancel("clone-cancel")]);
    expect(cancel).toHaveBeenCalledExactlyOnceWith(["original-cancel", "clone-cancel"]);
    expect(onBodyEnd).toHaveBeenCalledExactlyOnceWith({ kind: "unknown" });
  });

  it("does not let pending EOF feedback turn completed bytes into a provider deadline failure", async () => {
    const controller = new AbortController();
    let finishFeedback!: () => void;
    const response = await observeProviderResponseBody(new Response("complete"), {
      method: "GET",
      observation: "body",
      signal: controller.signal,
      onBodyEnd: () =>
        new Promise<void>((resolve) => {
          finishFeedback = resolve;
        }),
    });
    let result: Uint8Array | undefined;
    let failure: unknown;
    const consumed = readBoundedResponseBytes(response, {
      maxBytes: 100,
      fieldName: "fixture",
      createError: (message) => new Error(message),
      signal: controller.signal,
    }).then(
      (value) => {
        result = value;
      },
      (error: unknown) => {
        failure = error;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new DOMException("Provider deadline", "TimeoutError"));
    finishFeedback();
    await consumed;
    expect(failure).toBeUndefined();
    expect(new TextDecoder().decode(result)).toBe("complete");
  });

  it("does not let pending unknown feedback replace the provider body error with a later timeout", async () => {
    const controller = new AbortController();
    const providerError = new Error("Original provider body failure");
    let finishFeedback!: () => void;
    const response = await observeProviderResponseBody(
      new Response(
        new ReadableStream({
          pull(stream) {
            stream.error(providerError);
          },
        }),
      ),
      {
        method: "GET",
        observation: "body",
        signal: controller.signal,
        onBodyEnd: () =>
          new Promise<void>((resolve) => {
            finishFeedback = resolve;
          }),
      },
    );
    let failure: unknown;
    const consumed = readBoundedResponseBytes(response, {
      maxBytes: 100,
      fieldName: "fixture",
      createError: (message) => new Error(message),
      signal: controller.signal,
    }).catch((error: unknown) => {
      failure = error;
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new DOMException("Provider deadline", "TimeoutError"));
    finishFeedback();
    await consumed;
    expect(failure).toBe(providerError);
  });

  it("returns no-body and metadata responses without waiting for host bookkeeping", async () => {
    for (const [method, status, observation] of [
      ["GET", 204, "body"],
      ["HEAD", 200, "metadata_only"],
    ] as const) {
      let finishFeedback!: () => void;
      let returned: Response | undefined;
      const original = new Response(null, { status });
      const pending = observeProviderResponseBody(original, {
        method,
        observation,
        onBodyEnd: () =>
          new Promise<void>((resolve) => {
            finishFeedback = resolve;
          }),
      }).then((value) => {
        returned = value;
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(returned).toBe(original);
      finishFeedback();
      await pending;
    }
  });

  it.each([
    ["HEAD", 200],
    ["GET", 204],
    ["GET", 205],
    ["GET", 304],
  ])("recognizes a real %s/%i no-body transport response, never synthetic SDK metadata", async (method, status) => {
    const original = new Response(null, { status });
    const onBodyEnd = vi.fn();
    expect(await observeProviderResponseBody(original, { method, observation: "body", onBodyEnd })).toBe(original);
    expect(onBodyEnd).toHaveBeenCalledExactlyOnceWith({ kind: "eof" });
    const metadataEnd = vi.fn();
    expect(
      await observeProviderResponseBody(original, {
        method,
        observation: "metadata_only",
        onBodyEnd: metadataEnd,
      }),
    ).toBe(original);
    expect(metadataEnd).toHaveBeenCalledExactlyOnceWith({ kind: "unknown" });
  });

  it("does not invent EOF for arbitrary null/locked/used bodies", async () => {
    const plain = new Response(null);
    const locked = new Response("locked");
    const reader = locked.body!.getReader();
    const used = new Response("used");
    await used.text();
    for (const response of [plain, locked, used]) {
      const onBodyEnd = vi.fn();
      expect(await observeProviderResponseBody(response, { method: "GET", observation: "body", onBodyEnd })).toBe(
        response,
      );
      expect(onBodyEnd).toHaveBeenCalledExactlyOnceWith({ kind: "unknown" });
    }
    reader.releaseLock();
  });

  it("unread bodies stay outstanding; abort is unknown and cannot later become EOF", async () => {
    const controller = new AbortController();
    const onBodyEnd = vi.fn();
    const response = await observeProviderResponseBody(new Response("fixture"), {
      method: "GET",
      observation: "body",
      signal: controller.signal,
      onBodyEnd,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(onBodyEnd).not.toHaveBeenCalled();
    controller.abort();
    expect(await response.text()).toBe("fixture");
    expect(onBodyEnd).toHaveBeenCalledExactlyOnceWith({ kind: "unknown" });
  });

  it("observer failure cannot replace response bytes or create an upstream retry", async () => {
    const onBodyEnd = vi.fn(() => {
      throw new Error("Host receipt failure");
    });
    const response = await observeProviderResponseBody(Response.json({ ok: true }), {
      method: "GET",
      observation: "body",
      onBodyEnd,
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(onBodyEnd).toHaveBeenCalledExactlyOnceWith({ kind: "eof" });
  });
});
