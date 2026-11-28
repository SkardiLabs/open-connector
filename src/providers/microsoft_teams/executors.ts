import type { CredentialValidators, ProviderExecutors, ProviderProxyExecutor } from "../../core/types.ts";
import type { OAuthProviderContext, ProviderActionHandlers } from "../provider-executors.ts";

import {
  looseArray,
  optionalNumber,
  optionalRecord,
  optionalString,
  recordOrEmpty,
  requiredString,
} from "../../core/cast.ts";
import { compactJson, encodePathSegment } from "../../core/request.ts";
import { microsoftGraphJson, microsoftGraphRequest } from "../outlook/microsoft-graph.ts";
import { defineOAuthProviderExecutors } from "../provider-executors.ts";
import { defineProviderProxy } from "../provider-proxy.ts";
import { readProviderTextBody, requiredInputString } from "../provider-runtime.ts";

const service = "microsoft_teams";
const graphBaseUrl = "https://graph.microsoft.com/v1.0";
// The calendar fields a meeting record needs: the occurrence, its times, people, series, and join URL.
const calendarEventSelect =
  "id,iCalUId,subject,start,end,isOnlineMeeting,onlineMeeting,seriesMasterId,organizer,attendees";

type Handler = (input: Record<string, unknown>, context: OAuthProviderContext) => Promise<unknown>;

export const proxy: ProviderProxyExecutor = defineProviderProxy({
  service,
  baseUrl: graphBaseUrl,
  auth: { type: "oauth_bearer" },
  skipDnsValidation: true,
});

const handlers: ProviderActionHandlers<"microsoft_teams", Handler> = {
  get_current_user(_input, context) {
    return getCurrentUser(context);
  },
  list_joined_teams(input, context) {
    return listJoinedTeams(input, context);
  },
  get_team(input, context) {
    return getTeam(input, context);
  },
  list_team_channels(input, context) {
    return listTeamChannels(input, context);
  },
  get_channel(input, context) {
    return getChannel(input, context);
  },
  list_channel_messages(input, context) {
    return listChannelMessages(input, context);
  },
  list_chats(input, context) {
    return listChats(input, context);
  },
  list_chat_messages(input, context) {
    return listChatMessages(input, context);
  },
  send_channel_message(input, context) {
    return sendChannelMessage(input, context);
  },
  reply_to_channel_message(input, context) {
    return replyToChannelMessage(input, context);
  },
  send_chat_message(input, context) {
    return sendChatMessage(input, context);
  },
  list_calendar_view(input, context) {
    return listCalendarView(input, context);
  },
  get_online_meeting_by_join_url(input, context) {
    return getOnlineMeetingByJoinUrl(input, context);
  },
  list_meeting_transcripts(input, context) {
    return listMeetingTranscripts(input, context);
  },
  get_transcript_content(input, context) {
    return getTranscriptContent(input, context);
  },
  list_meeting_ai_insights(input, context) {
    return listMeetingAiInsights(input, context);
  },
};

export const executors: ProviderExecutors = defineOAuthProviderExecutors(service, handlers, {
  skipDnsValidation: true,
});

export const credentialValidators: CredentialValidators = {
  async oauth2(input, { fetcher, signal }) {
    const profile = await microsoftGraphJson<Record<string, unknown>>("me", {
      accessToken: input.accessToken,
      fetcher,
      signal,
      query: { $select: "id,displayName,mail,userPrincipalName" },
      label: "Microsoft Teams credential validation",
    });
    const accountId = requiredString(profile.id, "Microsoft Teams current account id");
    return {
      profile: {
        accountId,
        displayName:
          optionalString(profile.mail) ??
          optionalString(profile.userPrincipalName) ??
          optionalString(profile.displayName) ??
          accountId,
      },
      metadata: { currentAccount: profile },
    };
  },
};

async function getCurrentUser(context: OAuthProviderContext): Promise<unknown> {
  return microsoftGraphJson(
    "me",
    requestOptions(context, "get current user", {
      $select: "id,displayName,mail,userPrincipalName",
    }),
  );
}

async function listJoinedTeams(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const payload = await microsoftGraphJson<Record<string, unknown>>(
    optionalString(input.nextLink) ?? "me/joinedTeams",
    requestOptions(context, "list joined teams", undefined, (pathname) => pathname === "/v1.0/me/joinedTeams"),
  );
  return listOutput(payload, "teams");
}

async function getTeam(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const team = requiredInputString(input.teamId, "teamId");
  return microsoftGraphJson(
    `teams/${encodePathSegment(team)}`,
    requestOptions(context, "get team", { $select: stringList(input.select) }),
  );
}

async function listTeamChannels(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const team = requiredInputString(input.teamId, "teamId");
  const nextLink = optionalString(input.nextLink);
  const payload = await microsoftGraphJson<Record<string, unknown>>(
    nextLink ?? `teams/${encodePathSegment(team)}/channels`,
    requestOptions(
      context,
      "list team channels",
      nextLink
        ? undefined
        : {
            $select: stringList(input.select),
            $filter: optionalString(input.filter),
          },
      allowTeamChannelNextLink,
    ),
  );
  return listOutput(payload, "channels");
}

async function getChannel(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const team = requiredInputString(input.teamId, "teamId");
  const channel = requiredInputString(input.channelId, "channelId");
  return microsoftGraphJson(
    `teams/${encodePathSegment(team)}/channels/${encodePathSegment(channel)}`,
    requestOptions(context, "get channel", { $select: stringList(input.select) }),
  );
}

async function listChannelMessages(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const team = requiredInputString(input.teamId, "teamId");
  const channel = requiredInputString(input.channelId, "channelId");
  const nextLink = optionalString(input.nextLink);
  const payload = await microsoftGraphJson<Record<string, unknown>>(
    nextLink ?? `teams/${encodePathSegment(team)}/channels/${encodePathSegment(channel)}/messages`,
    requestOptions(
      context,
      "list channel messages",
      nextLink
        ? undefined
        : {
            $top: optionalNumber(input.top)?.toString(),
            $expand: input.includeReplies === true ? "replies" : undefined,
          },
      allowChannelMessageNextLink,
    ),
  );
  return listOutput(payload, "messages", normalizeChannelMessage);
}

async function listChats(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const payload = await microsoftGraphJson<Record<string, unknown>>(
    nextLink ?? "me/chats",
    requestOptions(
      context,
      "list chats",
      nextLink
        ? undefined
        : {
            $top: optionalNumber(input.top)?.toString(),
            $filter: optionalString(input.filter),
            $orderby: optionalString(input.orderby),
            $expand: optionalString(input.expand),
          },
      (pathname) => pathname === "/v1.0/me/chats" || pathname === "/v1.0/chats",
    ),
  );
  return listOutput(payload, "chats");
}

async function listChatMessages(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const chat = requiredInputString(input.chatId, "chatId");
  const nextLink = optionalString(input.nextLink);
  const payload = await microsoftGraphJson<Record<string, unknown>>(
    nextLink ?? `chats/${encodePathSegment(chat)}/messages`,
    requestOptions(
      context,
      "list chat messages",
      nextLink
        ? undefined
        : {
            $top: optionalNumber(input.top)?.toString(),
            $filter: optionalString(input.filter),
            $orderby: optionalString(input.orderby),
          },
      allowChatMessageNextLink,
    ),
  );
  return listOutput(payload, "messages");
}

async function sendChannelMessage(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const team = requiredInputString(input.teamId, "teamId");
  const channel = requiredInputString(input.channelId, "channelId");
  return microsoftGraphJson(
    `teams/${encodePathSegment(team)}/channels/${encodePathSegment(channel)}/messages`,
    requestOptions(context, "send channel message", undefined, undefined, messagePayload(input)),
  );
}

async function replyToChannelMessage(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const team = requiredInputString(input.teamId, "teamId");
  const channel = requiredInputString(input.channelId, "channelId");
  const message = requiredInputString(input.messageId, "messageId");
  return microsoftGraphJson(
    `teams/${encodePathSegment(team)}/channels/${encodePathSegment(channel)}/messages/${encodePathSegment(message)}/replies`,
    requestOptions(context, "reply to channel message", undefined, undefined, messagePayload(input)),
  );
}

async function sendChatMessage(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const chat = requiredInputString(input.chatId, "chatId");
  return microsoftGraphJson(
    `chats/${encodePathSegment(chat)}/messages`,
    requestOptions(context, "send chat message", undefined, undefined, messagePayload(input)),
  );
}

async function listCalendarView(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const nextLink = optionalString(input.nextLink);
  const payload = await microsoftGraphJson<Record<string, unknown>>(nextLink ?? "me/calendarView", {
    ...requestOptions(
      context,
      "list calendar view",
      nextLink
        ? undefined
        : {
            startDateTime: requiredInputString(input.startDateTime, "startDateTime"),
            endDateTime: requiredInputString(input.endDateTime, "endDateTime"),
            $select: calendarEventSelect,
            $top: optionalNumber(input.top)?.toString(),
          },
      allowCalendarViewNextLink,
    ),
    // Event times in UTC on every page, so a window caller never parses a mailbox time zone.
    headers: { prefer: 'outlook.timezone="UTC"' },
  });
  return listOutput(payload, "events");
}

async function getOnlineMeetingByJoinUrl(
  input: Record<string, unknown>,
  context: OAuthProviderContext,
): Promise<unknown> {
  const joinUrl = requiredInputString(input.joinUrl, "joinUrl");
  const payload = await microsoftGraphJson<Record<string, unknown>>(
    "me/onlineMeetings",
    requestOptions(context, "get online meeting by join URL", {
      // OData string literals escape a quote by doubling it.
      $filter: `JoinWebUrl eq '${joinUrl.replaceAll("'", "''")}'`,
    }),
  );
  return { onlineMeeting: looseArray(payload.value)[0] ?? null };
}

async function listMeetingTranscripts(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const meeting = requiredInputString(input.onlineMeetingId, "onlineMeetingId");
  const payload = await microsoftGraphJson<Record<string, unknown>>(
    optionalString(input.nextLink) ?? `me/onlineMeetings/${encodePathSegment(meeting)}/transcripts`,
    requestOptions(context, "list meeting transcripts", undefined, allowTranscriptNextLink),
  );
  return listOutput(payload, "transcripts");
}

async function getTranscriptContent(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const meeting = requiredInputString(input.onlineMeetingId, "onlineMeetingId");
  const transcriptId = requiredInputString(input.transcriptId, "transcriptId");
  const response = await microsoftGraphRequest(
    `me/onlineMeetings/${encodePathSegment(meeting)}/transcripts/${encodePathSegment(transcriptId)}/content`,
    {
      ...requestOptions(context, "get transcript content", { $format: "text/vtt" }),
      headers: { accept: "text/vtt" },
    },
  );
  return {
    contentType: "text/vtt",
    content: await readProviderTextBody(response, "Microsoft Teams transcript content", undefined, context.signal),
  };
}

async function listMeetingAiInsights(input: Record<string, unknown>, context: OAuthProviderContext): Promise<unknown> {
  const meeting = requiredInputString(input.onlineMeetingId, "onlineMeetingId");
  const nextLink = optionalString(input.nextLink);
  const userId = nextLink ? "" : (optionalString(input.userId) ?? (await currentUserId(context)));
  const insightsPath = `copilot/users/${encodePathSegment(userId)}/onlineMeetings/${encodePathSegment(meeting)}/aiInsights`;
  const payload = await microsoftGraphJson<Record<string, unknown>>(
    nextLink ?? insightsPath,
    requestOptions(context, "list meeting AI insights", undefined, allowAiInsightNextLink),
  );
  // The list answers only each insight's identity; its notes and action items come from the item read.
  const insights = [];
  for (const summary of looseArray(payload.value)) {
    const id = requiredString(optionalRecord(summary)?.id, "Microsoft Teams AI insight id");
    const itemPath = nextLink
      ? `${new URL(nextLink).pathname.replace(/^\/v1\.0\//u, "")}/${encodePathSegment(id)}`
      : `${insightsPath}/${encodePathSegment(id)}`;
    const insight = await microsoftGraphJson<Record<string, unknown>>(
      itemPath,
      requestOptions(context, "get meeting AI insight"),
    );
    insights.push(normalizeAiInsight(insight));
  }
  return {
    insights,
    nextLink: optionalString(payload["@odata.nextLink"]) ?? null,
  };
}

async function currentUserId(context: OAuthProviderContext): Promise<string> {
  const profile = await microsoftGraphJson<Record<string, unknown>>(
    "me",
    requestOptions(context, "get current user", { $select: "id" }),
  );
  return requiredString(profile.id, "Microsoft Teams current account id");
}

function normalizeAiInsight(insight: Record<string, unknown>): Record<string, unknown> {
  return {
    id: requiredString(insight.id, "Microsoft Teams AI insight id"),
    callId: optionalString(insight.callId) ?? null,
    contentCorrelationId: optionalString(insight.contentCorrelationId) ?? null,
    createdDateTime: optionalString(insight.createdDateTime) ?? null,
    endDateTime: optionalString(insight.endDateTime) ?? null,
    meetingNotes: looseArray(insight.meetingNotes).map((value) => {
      const note = recordOrEmpty(value);
      return {
        title: optionalString(note.title) ?? null,
        text: optionalString(note.text) ?? null,
        subpoints: looseArray(note.subpoints).map((subpoint) => ({
          title: optionalString(recordOrEmpty(subpoint).title) ?? null,
          text: optionalString(recordOrEmpty(subpoint).text) ?? null,
        })),
      };
    }),
    actionItems: looseArray(insight.actionItems).map((value) => {
      const item = recordOrEmpty(value);
      return {
        title: optionalString(item.title) ?? null,
        text: optionalString(item.text) ?? null,
        ownerDisplayName: optionalString(item.ownerDisplayName) ?? null,
      };
    }),
    viewpoint: optionalRecord(insight.viewpoint) ?? null,
  };
}

function requestOptions(
  context: OAuthProviderContext,
  operation: string,
  query?: Record<string, string | undefined>,
  allowNextLink?: (pathname: string) => boolean,
  body?: unknown,
) {
  return {
    accessToken: context.accessToken,
    fetcher: context.fetcher,
    signal: context.signal,
    query,
    allowNextLink,
    body,
    label: `Microsoft Teams ${operation}`,
  };
}

function messagePayload(input: Record<string, unknown>): unknown {
  return compactJson({
    body: optionalRecord(input.body),
    subject: input.subject,
    summary: input.summary,
    importance: input.importance,
    locale: input.locale,
    attachments: input.attachments,
    mentions: input.mentions,
  });
}

function listOutput(
  payload: Record<string, unknown>,
  key: string,
  normalize?: (value: unknown) => unknown,
): Record<string, unknown> {
  const values = looseArray(payload.value);
  return {
    [key]: normalize ? values.map(normalize) : values,
    nextLink: optionalString(payload["@odata.nextLink"]) ?? null,
  };
}

function normalizeChannelMessage(value: unknown): unknown {
  const message = optionalRecord(value);
  if (!message) {
    return value;
  }
  return {
    ...message,
    repliesNextLink: optionalString(message["replies@odata.nextLink"]) ?? null,
  };
}

function stringList(value: unknown): string | undefined {
  return Array.isArray(value) ? value.map(String).join(",") : undefined;
}

function allowTeamChannelNextLink(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 4 && segments[0] === "v1.0" && segments[1] === "teams" && segments[3] === "channels";
}

function allowChannelMessageNextLink(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const rootMessages =
    segments.length === 6 &&
    segments[0] === "v1.0" &&
    segments[1] === "teams" &&
    segments[3] === "channels" &&
    segments[5] === "messages";
  const replies =
    segments.length === 8 &&
    segments[0] === "v1.0" &&
    segments[1] === "teams" &&
    segments[3] === "channels" &&
    segments[5] === "messages" &&
    segments[7] === "replies";
  return rootMessages || replies;
}

function allowChatMessageNextLink(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 4 && segments[0] === "v1.0" && segments[1] === "chats" && segments[3] === "messages";
}

/** A calendarView continuation, which Graph may address through /me or through /users/{id}. */
function allowCalendarViewNextLink(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  const last = segments.at(-1)?.toLowerCase();
  return (
    last === "calendarview" &&
    segments[0] === "v1.0" &&
    ((segments.length === 3 && segments[1] === "me") || (segments.length === 4 && segments[1] === "users"))
  );
}

function allowTranscriptNextLink(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return (
    segments[0] === "v1.0" &&
    ((segments.length === 5 && segments[1] === "me" && segments[2] === "onlineMeetings") ||
      (segments.length === 6 && segments[1] === "users" && segments[3] === "onlineMeetings")) &&
    segments.at(-1) === "transcripts"
  );
}

function allowAiInsightNextLink(pathname: string): boolean {
  const segments = pathname.split("/").filter(Boolean);
  return (
    segments.length === 7 &&
    segments[0] === "v1.0" &&
    segments[1] === "copilot" &&
    segments[2] === "users" &&
    segments[4] === "onlineMeetings" &&
    segments[6] === "aiInsights"
  );
}
