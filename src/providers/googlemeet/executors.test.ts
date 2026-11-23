import type { ActionDefinition, ExecutionContext, ResolvedCredential } from "../../core/types.ts";
import type { ProviderFetch } from "../provider-runtime.ts";
import type { Schema } from "@cfworker/json-schema";

import { Validator } from "@cfworker/json-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import { serializeRuntimeActionResult } from "../../server/api/runtime-api.ts";
import { getProviderActionHandler } from "../provider-executors.ts";
import { toProviderExecutionError } from "../provider-runtime.ts";
import { provider } from "./definition.ts";
import { credentialValidators, googleMeetActionHandlers, proxy } from "./executors.ts";

const accessToken = "google-meet-access-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google Meet OAuth execution", () => {
  it("validates the credential through Google user info", async () => {
    const fetcher: ProviderFetch = vi.fn(async (url, init) => {
      expect(url.toString()).toBe("https://www.googleapis.com/oauth2/v3/userinfo");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
      return Response.json({ sub: "google-user-1", email: "meet@example.com", name: "Meet User" });
    });

    const result = await credentialValidators.oauth2!(
      {
        authType: "oauth2",
        accessToken,
        tokenType: "Bearer",
        profile: { accountId: "oauth2", displayName: "OAuth Credential", grantedScopes: [] },
        metadata: {},
      },
      { fetcher },
    );

    expect(result).toMatchObject({
      profile: { accountId: "meet@example.com", displayName: "Meet User" },
      metadata: { currentAccount: { sub: "google-user-1", email: "meet@example.com" } },
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("creates a meeting space with Bearer authentication", async () => {
    const fetcher: ProviderFetch = vi.fn(async (url, init) => {
      expect(url.toString()).toBe("https://meet.googleapis.com/v2/spaces");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
      expect(JSON.parse(String(init?.body))).toEqual({ config: { accessType: "TRUSTED" } });
      return Response.json({
        name: "spaces/space-1",
        meetingCode: "abc-mnop-xyz",
        meetingUri: "https://meet.google.com/abc-mnop-xyz",
      });
    });

    await expect(
      googleMeetActionHandlers.create_space({ space: { config: { accessType: "TRUSTED" } } }, { accessToken, fetcher }),
    ).resolves.toMatchObject({ name: "spaces/space-1", meetingCode: "abc-mnop-xyz" });
  });

  it("constructs participant list paths and pagination query values", async () => {
    const fetcher: ProviderFetch = vi.fn(async (url) => {
      const target = new URL(url);
      expect(target.origin + target.pathname).toBe(
        "https://meet.googleapis.com/v2/conferenceRecords/record-1/participants",
      );
      expect(Object.fromEntries(target.searchParams)).toEqual({
        filter: "latest_end_time IS NULL",
        pageSize: "250",
        pageToken: "next-1",
      });
      return Response.json({
        participants: [{ name: "conferenceRecords/record-1/participants/person-1" }],
        totalSize: 1,
      });
    });

    await expect(
      googleMeetActionHandlers.list_participants(
        {
          parent: "record-1",
          filter: "latest_end_time IS NULL",
          pageSize: 250,
          pageToken: "next-1",
        },
        { accessToken, fetcher },
      ),
    ).resolves.toEqual({
      participants: [{ name: "conferenceRecords/record-1/participants/person-1" }],
      nextPageToken: null,
      totalSize: 1,
    });
  });

  it("omits unsupported filters from transcript list requests", async () => {
    const fetcher: ProviderFetch = vi.fn(async (url) => {
      const target = new URL(url);
      expect(target.origin + target.pathname).toBe(
        "https://meet.googleapis.com/v2/conferenceRecords/record-1/transcripts",
      );
      expect(Object.fromEntries(target.searchParams)).toEqual({ pageSize: "10", pageToken: "next-1" });
      return Response.json({ transcripts: [], nextPageToken: "next-2" });
    });

    await expect(
      googleMeetActionHandlers.list_transcripts(
        {
          parent: "record-1",
          filter: "start_time > 2026-01-01T00:00:00Z",
          pageSize: 10,
          pageToken: "next-1",
        },
        { accessToken, fetcher },
      ),
    ).resolves.toEqual({ transcripts: [], nextPageToken: "next-2" });
  });

  it("updates a meeting space with an update mask", async () => {
    const fetcher: ProviderFetch = vi.fn(async (url, init) => {
      const target = new URL(url);
      expect(target.origin + target.pathname).toBe("https://meet.googleapis.com/v2/spaces/space-1");
      expect(Object.fromEntries(target.searchParams)).toEqual({ updateMask: "config.accessType" });
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        name: "spaces/space-1",
        config: { accessType: "OPEN" },
      });
      return Response.json({ name: "spaces/space-1", config: { accessType: "OPEN" } });
    });

    await expect(
      googleMeetActionHandlers.update_space(
        {
          name: "spaces/space-1",
          space: { config: { accessType: "OPEN" } },
          updateMask: "config.accessType",
        },
        { accessToken, fetcher },
      ),
    ).resolves.toMatchObject({ name: "spaces/space-1", config: { accessType: "OPEN" } });
  });

  it("ends an active conference through the custom method", async () => {
    const fetcher: ProviderFetch = vi.fn(async (url, init) => {
      expect(url.toString()).toBe("https://meet.googleapis.com/v2/spaces/space-1:endActiveConference");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({});
      return Response.json({});
    });

    await expect(
      googleMeetActionHandlers.end_active_conference({ name: "spaces/space-1" }, { accessToken, fetcher }),
    ).resolves.toEqual({ success: true });
  });
});

describe("Google Meet resource names", () => {
  const fetcher: ProviderFetch = async () => {
    throw new Error("invalid resource names must not be fetched");
  };
  const context = { accessToken, fetcher };

  it.each([
    ["space traversal", "get_space", { name: "spaces/.." }],
    ["bare space ID for update", "update_space", { name: "space-1" }],
    ["meeting-code alias for update", "update_space", { name: "spaces/abc-mnop-xyz" }],
    ["bare space ID for end active conference", "end_active_conference", { name: "space-1" }],
    ["meeting-code alias for end active conference", "end_active_conference", { name: "spaces/abc-mnop-xyz" }],
    ["conference record traversal", "get_conference_record", { name: "conferenceRecords/%2e%2e" }],
    ["participant traversal", "get_participant", { name: "conferenceRecords/record-1/participants/.." }],
    [
      "participant session with a missing participant",
      "get_participant_session",
      { name: "conferenceRecords/record-1/participantSessions/session-1" },
    ],
    [
      "recording with extra path segments",
      "get_recording",
      { name: "conferenceRecords/record-1/recordings/recording-1/file" },
    ],
    [
      "transcript entry traversal",
      "get_transcript_entry",
      { name: "conferenceRecords/record-1/transcripts/transcript-1/entries/%2E%2E" },
    ],
  ])("rejects %s", async (_description, action, input) => {
    await expect(getProviderActionHandler(googleMeetActionHandlers, action)!(input, context)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("Google Meet proxy", () => {
  const credential: ResolvedCredential = {
    authType: "oauth2",
    accessToken,
    tokenType: "Bearer",
    profile: { accountId: "meet@example.com", displayName: "Meet User", grantedScopes: [] },
    metadata: {},
  };
  const context: ExecutionContext = {
    getCredential: async () => credential,
  };

  it("routes only v2 requests with the stored OAuth credential", async () => {
    const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url.toString()).toBe("https://meet.googleapis.com/v2/conferenceRecords?pageSize=1");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
      return Response.json({ conferenceRecords: [] });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await proxy(
      {
        method: "GET",
        endpoint: "/v2/conferenceRecords",
        query: { pageSize: 1 },
        headers: { authorization: "Bearer caller-supplied-token" },
      },
      context,
    );

    expect(result).toMatchObject({ ok: true, response: { status: 200, data: { conferenceRecords: [] } } });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects endpoints outside the Meet v2 API", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(proxy({ method: "GET", endpoint: "/oauth2/v2/userinfo" }, context)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    await expect(proxy({ method: "GET", endpoint: "/v2beta/conferenceRecords" }, context)).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Google Meet meeting window and identity", () => {
  it("builds the start-time filter from startTime and endTime", async () => {
    const fetcher: ProviderFetch = vi.fn(async (url) => {
      const target = new URL(url);
      expect(target.origin + target.pathname).toBe("https://meet.googleapis.com/v2/conferenceRecords");
      expect(Object.fromEntries(target.searchParams)).toEqual({
        filter: 'start_time>="2026-11-01T00:00:00Z" AND start_time<="2026-11-08T00:00:00Z"',
        pageSize: "100",
        pageToken: "page-2",
      });
      return Response.json({
        conferenceRecords: [{ name: "conferenceRecords/record-1", startTime: "2026-11-02T09:00:00Z" }],
        nextPageToken: "page-3",
      });
    });

    await expect(
      googleMeetActionHandlers.list_conference_records(
        { startTime: "2026-11-01T00:00:00Z", endTime: "2026-11-08T00:00:00Z", pageSize: 100, pageToken: "page-2" },
        { accessToken, fetcher },
      ),
    ).resolves.toEqual({
      conferenceRecords: [{ name: "conferenceRecords/record-1", startTime: "2026-11-02T09:00:00Z" }],
      nextPageToken: "page-3",
    });
  });

  it("combines a caller filter with the window", async () => {
    const fetcher: ProviderFetch = vi.fn(async (url) => {
      expect(new URL(url).searchParams.get("filter")).toBe(
        '(space.meeting_code="abc-mnop-xyz") AND start_time>="2026-11-01T00:00:00Z"',
      );
      return Response.json({});
    });

    await googleMeetActionHandlers.list_conference_records(
      { filter: 'space.meeting_code="abc-mnop-xyz"', startTime: "2026-11-01T00:00:00Z" },
      { accessToken, fetcher },
    );
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("answers an empty conferenceRecords array for Google's empty page", async () => {
    const fetcher: ProviderFetch = vi.fn(async () => Response.json({}));

    await expect(
      googleMeetActionHandlers.list_conference_records(
        { startTime: "2026-11-01T00:00:00Z", endTime: "2026-11-08T00:00:00Z" },
        { accessToken, fetcher },
      ),
    ).resolves.toEqual({ conferenceRecords: [], nextPageToken: null });
  });

  it("refuses a window bound that is not an RFC 3339 time before calling Google", async () => {
    const fetcher: ProviderFetch = vi.fn();

    await expect(
      googleMeetActionHandlers.list_conference_records(
        { startTime: '2026-11-01T00:00:00Z" OR start_time>="1970-01-01T00:00:00Z' },
        { accessToken, fetcher },
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reads the connected account's subject and email from userinfo", async () => {
    const fetcher: ProviderFetch = vi.fn(async (url, init) => {
      expect(url.toString()).toBe("https://www.googleapis.com/oauth2/v3/userinfo");
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);
      return Response.json({
        sub: "110248495921238986420",
        email: "meet@example.com",
        email_verified: true,
        name: "Meet User",
        hd: "example.com",
      });
    });

    await expect(googleMeetActionHandlers.get_current_user({}, { accessToken, fetcher })).resolves.toEqual({
      sub: "110248495921238986420",
      email: "meet@example.com",
      emailVerified: true,
      name: "Meet User",
      picture: null,
      hostedDomain: "example.com",
    });
  });
});

describe("Google Meet conference artifacts", () => {
  // Constructed Meet REST v2 wire shapes, not live-account captures.
  const recordName = "conferenceRecords/record-1";
  const conferenceRecord = {
    name: recordName,
    space: "spaces/space-1",
    startTime: "2026-11-24T09:00:00.123456Z",
    endTime: "2026-11-24T09:45:00Z",
    expireTime: "2026-12-24T09:45:00Z",
  };
  const generatedNote = {
    name: `${recordName}/smartNotes/note-1`,
    state: "FILE_GENERATED",
    startTime: "2026-11-24T09:01:00Z",
    endTime: "2026-11-24T09:44:00Z",
    docsDestination: {
      document: "1AbCdEfGhIjKlMnOpQrStUvWxYz",
      exportUri: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit",
    },
  };

  function artifactsAction(): ActionDefinition {
    return provider.actions.find((action) => action.name === "get_conference_artifacts")!;
  }

  it("reads the record and walks every smart-notes page", async () => {
    const requests: URL[] = [];
    const fetcher: ProviderFetch = vi.fn(async (url) => {
      const target = new URL(url);
      requests.push(target);
      if (target.pathname === `/v2/${recordName}`) {
        return Response.json(conferenceRecord);
      }
      if (!target.searchParams.has("pageToken")) {
        return Response.json({ smartNotes: [generatedNote], nextPageToken: "notes-page-2" });
      }
      // A session still running has no document yet.
      return Response.json({
        smartNotes: [{ name: `${recordName}/smartNotes/note-2`, state: "STARTED", startTime: "2026-11-24T09:30:00Z" }],
      });
    });

    const output = await googleMeetActionHandlers.get_conference_artifacts(
      { name: recordName },
      { accessToken, fetcher },
    );

    expect(output).toEqual({
      conferenceRecord,
      smartNotes: [
        generatedNote,
        { name: `${recordName}/smartNotes/note-2`, state: "STARTED", startTime: "2026-11-24T09:30:00Z" },
      ],
    });
    expect(requests.map((target) => target.pathname + target.search)).toEqual([
      `/v2/${recordName}`,
      `/v2/${recordName}/smartNotes?pageSize=100`,
      `/v2/${recordName}/smartNotes?pageSize=100&pageToken=notes-page-2`,
    ]);
    const validation = new Validator(artifactsAction().outputSchema as Schema, "2020-12").validate(output);
    expect(validation.errors).toEqual([]);
  });

  it("answers an empty smartNotes array for a conference without notes", async () => {
    const fetcher: ProviderFetch = vi.fn(async (url) =>
      Response.json(new URL(url).pathname.endsWith("/smartNotes") ? {} : conferenceRecord),
    );

    await expect(
      googleMeetActionHandlers.get_conference_artifacts({ name: recordName }, { accessToken, fetcher }),
    ).resolves.toEqual({ conferenceRecord, smartNotes: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails as a provider error instead of truncating past the page cap", async () => {
    const fetcher: ProviderFetch = vi.fn(async (url) =>
      Response.json(
        new URL(url).pathname.endsWith("/smartNotes")
          ? { smartNotes: [generatedNote], nextPageToken: "always-more" }
          : conferenceRecord,
      ),
    );

    await expect(
      googleMeetActionHandlers.get_conference_artifacts({ name: recordName }, { accessToken, fetcher }),
    ).rejects.toMatchObject({ status: 502 });
    // The record, then ten pages of notes.
    expect(fetcher).toHaveBeenCalledTimes(11);
  });

  it("passes an expired record's 404 through as the runtime's 404 envelope", async () => {
    const fetcher: ProviderFetch = vi.fn(async () =>
      Response.json(
        { error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } },
        { status: 404 },
      ),
    );

    const error = await googleMeetActionHandlers
      .get_conference_artifacts({ name: recordName }, { accessToken, fetcher })
      .catch((caught: unknown) => caught);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(
      serializeRuntimeActionResult({
        actionId: "googlemeet.get_conference_artifacts",
        executionId: "fixture-execution",
        auditPersisted: false,
        result: toProviderExecutionError(error, "fixture request failed"),
      }),
    ).toMatchObject({ status: 404, body: { success: false, errorCode: "invalid_input", data: { status: 404 } } });
  });

  it.each(["spaces/space-1", `${recordName}/participants/person-1`, "conferenceRecords/../record-1"])(
    "refuses %s as a conference record name before any request",
    async (name) => {
      const fetcher: ProviderFetch = vi.fn();

      await expect(
        googleMeetActionHandlers.get_conference_artifacts({ name }, { accessToken, fetcher }),
      ).rejects.toMatchObject({ status: 400 });
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
