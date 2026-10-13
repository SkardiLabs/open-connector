import type { GmailRateLimitOptions } from "./rate-limit.ts";

import { describe, expect, it } from "vitest";
import { gmailActionHandlers } from "./executors.ts";
import { createGmailRateLimitedFetch } from "./rate-limit.ts";

function fakeClock(): Required<Pick<GmailRateLimitOptions, "now" | "sleep" | "random">> & { slept: number[] } {
  let time = 0;
  const slept: number[] = [];
  return {
    slept,
    now: () => time,
    sleep: async (ms) => {
      slept.push(ms);
      time += ms;
    },
    random: () => 1,
  };
}

const throttled = () =>
  new Response(JSON.stringify({ error: { code: 429, message: "Too many concurrent requests for user" } }), {
    status: 429,
  });

describe("Gmail rate-limit pacing", () => {
  it("waits out a 429 with exponential backoff and returns the eventual success", async () => {
    const clock = fakeClock();
    const responses = [throttled(), throttled(), new Response("{}", { status: 200 })];
    const fetcher = createGmailRateLimitedFetch(async () => responses.shift()!, clock);

    const response = await fetcher("https://gmail.googleapis.com/gmail/v1/users/me/messages");

    expect(response.status).toBe(200);
    expect(clock.slept).toEqual([1000, 2000]);
  });

  it("honors Retry-After over its own backoff", async () => {
    const clock = fakeClock();
    const responses = [
      new Response("", { status: 429, headers: { "retry-after": "3" } }),
      new Response("{}", { status: 200 }),
    ];
    const fetcher = createGmailRateLimitedFetch(async () => responses.shift()!, clock);

    await fetcher("https://gmail.googleapis.com/gmail/v1/users/me/profile");

    expect(clock.slept).toEqual([3000]);
  });

  it("treats a 403 userRateLimitExceeded as a throttle but not other 403s", async () => {
    const clock = fakeClock();
    const rateLimited403 = new Response(
      JSON.stringify({ error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }),
      { status: 403 },
    );
    const responses = [rateLimited403, new Response("{}", { status: 200 })];
    const fetcher = createGmailRateLimitedFetch(async () => responses.shift()!, clock);
    expect((await fetcher("https://gmail.googleapis.com/x")).status).toBe(200);

    const forbidden = new Response(
      JSON.stringify({ error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } }),
      {
        status: 403,
      },
    );
    const plain = createGmailRateLimitedFetch(async () => forbidden, fakeClock());
    const response = await plain("https://gmail.googleapis.com/x");
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 403 } });
  });

  it("does not retry a write", async () => {
    let calls = 0;
    const fetcher = createGmailRateLimitedFetch(async () => {
      calls += 1;
      return throttled();
    }, fakeClock());

    const response = await fetcher("https://gmail.googleapis.com/x", { method: "POST" });

    expect(response.status).toBe(429);
    expect(calls).toBe(1);
  });

  it("gives up at its budget and returns the throttled response unread", async () => {
    const clock = fakeClock();
    const fetcher = createGmailRateLimitedFetch(async () => throttled(), { ...clock, budgetMs: 10_000 });

    const response = await fetcher("https://gmail.googleapis.com/x");

    expect(response.status).toBe(429);
    // 1s + 2s + 4s fit in 10s; the next 8s wait would not.
    expect(clock.slept).toEqual([1000, 2000, 4000]);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 429 } });
  });

  it("pauses the whole fan-out when one hydration is throttled", async () => {
    const clock = fakeClock();
    const sentAt: Array<{ url: string; at: number }> = [];
    let throttledOnce = false;
    const upstream = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      sentAt.push({ url, at: clock.now() });
      if (url.includes("/messages?")) {
        return Response.json({
          messages: [
            { id: "a", threadId: "t" },
            { id: "b", threadId: "t" },
          ],
        });
      }
      if (url.includes("/messages/a") && !throttledOnce) {
        throttledOnce = true;
        return throttled();
      }
      const id = url.includes("/messages/a") ? "a" : "b";
      return Response.json({ id, threadId: "t", payload: { headers: [] } });
    };

    const output = (await gmailActionHandlers.fetch_emails(
      { maxResults: 2 },
      { userId: "me", accessToken: "token", fetcher: createGmailRateLimitedFetch(upstream, clock) },
    )) as { messages: Array<{ messageId: string }> };

    expect(output.messages.map((message) => message.messageId)).toEqual(["a", "b"]);
    expect(clock.slept).toEqual([1000]);
    expect(sentAt.filter((entry) => entry.url.includes("/messages/a")).map((entry) => entry.at)).toEqual([0, 1000]);
  });

  it("surfaces an exhausted throttle as a 429 provider error", async () => {
    const fetcher = createGmailRateLimitedFetch(async () => throttled(), { ...fakeClock(), budgetMs: 0 });

    await expect(
      gmailActionHandlers.get_profile({}, { userId: "me", accessToken: "token", fetcher }),
    ).rejects.toMatchObject({ status: 429 });
  });
});
