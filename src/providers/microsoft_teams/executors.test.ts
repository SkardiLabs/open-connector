import type { ExecutionContext, ResolvedCredential } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "../../core/execution.ts";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { provider } from "./definition.ts";
import { executors } from "./executors.ts";

const credential: Extract<ResolvedCredential, { authType: "oauth2" }> = {
  authType: "oauth2",
  accessToken: "teams-token",
  tokenType: "Bearer",
  profile: { accountId: "teams-user", displayName: "Teams User", grantedScopes: [] },
  metadata: {},
};

beforeEach(() => setDefaultGuardedFetchDnsLookup(null));

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(undefined);
  vi.unstubAllGlobals();
});

describe("Microsoft Teams execution", () => {
  it("expands channel replies and preserves their continuation URL", async () => {
    let request: Request | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json({
        value: [
          {
            id: "message-1",
            replies: [{ id: "reply-1" }],
            "replies@odata.nextLink":
              "https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/messages/message-1/replies?$skiptoken=x",
          },
        ],
      });
    });

    const result = await execute("list_channel_messages", {
      teamId: "team-1",
      channelId: "channel-1",
      includeReplies: true,
      top: 20,
    });

    expect(request && new URL(request.url).searchParams.get("$expand")).toBe("replies");
    expect(result).toMatchObject({
      ok: true,
      output: {
        messages: [{ id: "message-1", replies: [{ id: "reply-1" }], repliesNextLink: expect.any(String) }],
        nextLink: null,
      },
    });
  });

  it("sends structured chat messages to an existing chat", async () => {
    let request: Request | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json({ id: "sent-1", body: { contentType: "html", content: "Hello" } }, { status: 201 });
    });

    const result = await execute("send_chat_message", {
      chatId: "chat/1",
      body: { contentType: "html", content: "Hello" },
      mentions: [{ id: 0, mentionText: "Person", mentioned: { user: { id: "user-1" } } }],
    });

    expect(request?.url).toContain("/v1.0/chats/chat%2F1/messages");
    expect(await request?.json()).toMatchObject({ body: { contentType: "html", content: "Hello" } });
    expect(result).toMatchObject({ ok: true, output: { id: "sent-1" } });
  });
});

describe("Microsoft Teams meeting records", () => {
  it("lists calendar events in a UTC window with the meeting fields", async () => {
    let request: Request | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json({
        value: [
          {
            id: "AAMkAGI2-occurrence-1",
            iCalUId: "040000008200E00074C5B7101A82E008",
            subject: "Weekly sync",
            start: { dateTime: "2026-11-02T09:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-11-02T09:45:00.0000000", timeZone: "UTC" },
            isOnlineMeeting: true,
            onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_1%40thread.v2/0" },
            seriesMasterId: "AAMkAGI2-master",
            organizer: { emailAddress: { name: "Host", address: "host@example.com" } },
            attendees: [
              {
                type: "required",
                status: { response: "accepted", time: "2026-11-01T10:00:00Z" },
                emailAddress: { name: "Guest", address: "guest@example.com" },
              },
            ],
          },
        ],
        "@odata.nextLink":
          "https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=2026-11-01T00%3a00%3a00Z&endDateTime=2026-11-08T00%3a00%3a00Z&%24skiptoken=abc",
      });
    });

    const result = await execute("list_calendar_view", {
      startDateTime: "2026-11-01T00:00:00Z",
      endDateTime: "2026-11-08T00:00:00Z",
      top: 50,
    });

    const url = new URL(request!.url);
    expect(url.pathname).toBe("/v1.0/me/calendarView");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      startDateTime: "2026-11-01T00:00:00Z",
      endDateTime: "2026-11-08T00:00:00Z",
      $select: "id,iCalUId,subject,start,end,isOnlineMeeting,onlineMeeting,seriesMasterId,organizer,attendees",
      $top: "50",
    });
    expect(request!.headers.get("prefer")).toBe('outlook.timezone="UTC"');
    expect(result).toMatchObject({
      ok: true,
      output: {
        events: [{ id: "AAMkAGI2-occurrence-1", seriesMasterId: "AAMkAGI2-master" }],
        nextLink: expect.any(String),
      },
    });
  });

  it("follows a calendarView nextLink as given and ends with a null nextLink", async () => {
    const nextLink =
      "https://graph.microsoft.com/v1.0/users/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7/calendarView?%24skiptoken=abc";
    let requested = "";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requested = (input instanceof Request ? input : new Request(input, init)).url;
      return Response.json({ value: [] });
    });

    const result = await execute("list_calendar_view", {
      startDateTime: "2026-11-01T00:00:00Z",
      endDateTime: "2026-11-08T00:00:00Z",
      nextLink,
    });

    expect(requested).toBe(nextLink);
    expect(result).toMatchObject({ ok: true, output: { events: [], nextLink: null } });
  });

  it("refuses a nextLink outside calendarView", async () => {
    vi.stubGlobal("fetch", vi.fn());

    const result = await execute("list_calendar_view", {
      startDateTime: "2026-11-01T00:00:00Z",
      endDateTime: "2026-11-08T00:00:00Z",
      nextLink: "https://graph.microsoft.com/v1.0/me/messages?%24skiptoken=abc",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps Graph's status when a page link is refused", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({ error: { code: "SyncStateNotFound", message: "The sync state is gone." } }, { status: 410 }),
    );

    const result = await execute("list_calendar_view", {
      startDateTime: "2026-11-01T00:00:00Z",
      endDateTime: "2026-11-08T00:00:00Z",
      nextLink: "https://graph.microsoft.com/v1.0/me/calendarView?%24skiptoken=stale",
    });

    expect(result).toMatchObject({ ok: false, error: { code: "invalid_input", details: { status: 410 } } });
  });

  it("finds an online meeting by join URL with a quoted OData filter", async () => {
    let request: Request | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return Response.json({
        value: [
          { id: "MSpkYzE3-meeting", joinWebUrl: "https://teams.microsoft.com/l/meetup-join/x'y", subject: "Sync" },
        ],
      });
    });

    const result = await execute("get_online_meeting_by_join_url", {
      joinUrl: "https://teams.microsoft.com/l/meetup-join/x'y",
    });

    expect(new URL(request!.url).searchParams.get("$filter")).toBe(
      "JoinWebUrl eq 'https://teams.microsoft.com/l/meetup-join/x''y'",
    );
    expect(result).toMatchObject({ ok: true, output: { onlineMeeting: { id: "MSpkYzE3-meeting" } } });
  });

  it("answers a null online meeting when no meeting matches", async () => {
    vi.stubGlobal("fetch", async () => Response.json({ value: [] }));

    const result = await execute("get_online_meeting_by_join_url", {
      joinUrl: "https://teams.microsoft.com/l/meetup-join/none",
    });

    expect(result).toMatchObject({ ok: true, output: { onlineMeeting: null } });
  });

  it("reads transcript content as WebVTT text", async () => {
    let request: Request | undefined;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      request = input instanceof Request ? input : new Request(input, init);
      return new Response("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\n<v Host>Hello.</v>\n", {
        headers: { "content-type": "text/vtt" },
      });
    });

    const result = await execute("get_transcript_content", {
      onlineMeetingId: "MSpkYzE3-meeting",
      transcriptId: "MSMjMCMj-transcript",
    });

    const url = new URL(request!.url);
    expect(url.pathname).toBe("/v1.0/me/onlineMeetings/MSpkYzE3-meeting/transcripts/MSMjMCMj-transcript/content");
    expect(url.searchParams.get("$format")).toBe("text/vtt");
    expect(result).toMatchObject({
      ok: true,
      output: { contentType: "text/vtt", content: expect.stringContaining("<v Host>Hello.</v>") },
    });
  });

  it("reads each AI insight's notes and action items for the connected user", async () => {
    const requested: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL((input instanceof Request ? input : new Request(input, init)).url);
      requested.push(url.pathname);
      if (url.pathname === "/v1.0/me") {
        return Response.json({ id: "0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7" });
      }
      if (url.pathname.endsWith("/aiInsights")) {
        return Response.json({ value: [{ id: "insight-1", callId: "call-1" }] });
      }
      return Response.json({
        id: "insight-1",
        callId: "call-1",
        contentCorrelationId: "correlation-1",
        createdDateTime: "2026-11-02T09:50:00Z",
        endDateTime: "2026-11-02T09:45:00Z",
        meetingNotes: [{ title: "Release", text: "Shipped.", subpoints: [{ title: "Docs", text: "Updated." }] }],
        actionItems: [{ title: "Changelog", text: "Write the changelog.", ownerDisplayName: "Host" }],
        viewpoint: { mentionEvents: [] },
      });
    });

    const result = await execute("list_meeting_ai_insights", { onlineMeetingId: "MSpkYzE3-meeting" });

    expect(requested).toEqual([
      "/v1.0/me",
      "/v1.0/copilot/users/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7/onlineMeetings/MSpkYzE3-meeting/aiInsights",
      "/v1.0/copilot/users/0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7/onlineMeetings/MSpkYzE3-meeting/aiInsights/insight-1",
    ]);
    expect(result).toMatchObject({
      ok: true,
      output: {
        insights: [
          {
            id: "insight-1",
            meetingNotes: [{ title: "Release", text: "Shipped.", subpoints: [{ title: "Docs", text: "Updated." }] }],
            actionItems: [{ title: "Changelog", text: "Write the changelog.", ownerDisplayName: "Host" }],
          },
        ],
        nextLink: null,
      },
    });
  });
});

async function execute(actionName: string, input: Record<string, unknown>) {
  const context: ExecutionContext = {
    async getCredential(service) {
      expect(service).toBe("microsoft_teams");
      return credential;
    },
  };
  return executeAction(
    provider.actions.find((action) => action.name === actionName)!,
    executors[`microsoft_teams.${actionName}`],
    input,
    context,
  );
}
