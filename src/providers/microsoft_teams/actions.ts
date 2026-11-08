import type { ActionDefinition, JsonSchema } from "../../core/types.ts";

import { s } from "../../core/json-schema.ts";
import { defineProviderAction } from "../../core/provider-definition.ts";
import {
  microsoftTeamsAiInsightReadScopes,
  microsoftTeamsCalendarReadScopes,
  microsoftTeamsChannelMessageReadScopes,
  microsoftTeamsChannelMessageSendScopes,
  microsoftTeamsChannelScopes,
  microsoftTeamsChatMessageSendScopes,
  microsoftTeamsChatReadScopes,
  microsoftTeamsOnlineMeetingReadScopes,
  microsoftTeamsProfileScopes,
  microsoftTeamsTeamScopes,
  microsoftTeamsTranscriptReadScopes,
} from "./scopes.ts";

const service = "microsoft_teams";

interface MicrosoftTeamsActionSource {
  name: string;
  operationType: ActionDefinition["operationType"];
  description: string;
  requiredScopes: string[];
  providerPermissions: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
}

const rawObject = s.record(true, { description: "A Microsoft Graph object." });
const teamId = s.nonEmptyString("Microsoft Teams team ID.");
const channelId = s.nonEmptyString("Microsoft Teams channel ID.");
const chatId = s.nonEmptyString("Microsoft Teams chat ID.");
const messageId = s.nonEmptyString("Microsoft Teams message ID.");
const nextLink = s.url("Opaque Microsoft Graph pagination URL returned by a previous call.");
const select = s.stringArray("Microsoft Graph fields to include in the response.", { minItems: 1 });
const user = s.looseObject(
  {
    id: s.nonEmptyString("Microsoft account ID."),
    displayName: s.string("Account display name."),
    mail: s.nullableString("Primary email address."),
    userPrincipalName: s.string("User principal name."),
  },
  { description: "Current Microsoft account profile." },
);
const team = s.looseObject(
  {
    id: s.nonEmptyString("Team ID."),
    displayName: s.nonEmptyString("Team display name."),
    description: s.nullableString("Team description."),
    webUrl: s.string("Microsoft Teams web URL."),
    isArchived: s.boolean("Whether the team is archived."),
    tenantId: s.string("Microsoft Entra tenant ID."),
  },
  { description: "Microsoft Teams team resource." },
);
const channel = s.looseObject(
  {
    id: s.nonEmptyString("Channel ID."),
    displayName: s.nonEmptyString("Channel display name."),
    description: s.nullableString("Channel description."),
    membershipType: s.string("Standard, private, or shared membership type."),
    webUrl: s.string("Microsoft Teams channel URL."),
    tenantId: s.string("Microsoft Entra tenant ID."),
  },
  { description: "Microsoft Teams channel resource." },
);
const chat = s.looseObject(
  {
    id: s.nonEmptyString("Chat ID."),
    topic: s.nullableString("Chat topic."),
    chatType: s.string("One-on-one, group, or meeting chat type."),
    webUrl: s.string("Microsoft Teams chat URL."),
    tenantId: s.string("Microsoft Entra tenant ID."),
    members: s.array(rawObject, { description: "Chat members when expanded." }),
    lastMessagePreview: rawObject,
  },
  { description: "Microsoft Teams chat resource." },
);
const itemBody = s.object(
  {
    contentType: s.stringEnum(["text", "html"], { description: "Message body content type." }),
    content: s.string("Message body content."),
  },
  { required: ["contentType", "content"], description: "Teams message body." },
);
const attachment = s.looseObject(
  {
    id: s.string("Attachment ID referenced by the message body."),
    contentType: s.nonEmptyString("Attachment MIME type or reference type."),
    contentUrl: s.nullableString("URL for a reference attachment."),
    content: s.nullableString("Serialized attachment content."),
    name: s.nullableString("Attachment name."),
    thumbnailUrl: s.nullableString("Attachment thumbnail URL."),
  },
  { description: "Teams chat message attachment." },
);
const mention = s.looseObject(
  {
    id: s.integer({ minimum: 0, description: "Mention identifier used by the body markup." }),
    mentionText: s.nonEmptyString("Text displayed for the mention."),
    mentioned: rawObject,
  },
  { description: "Teams chat message mention." },
);
const message = s.looseObject(
  {
    id: s.nonEmptyString("Message ID."),
    replyToId: s.nullableString("Parent message ID for a channel reply."),
    messageType: s.string("Message type."),
    createdDateTime: s.string("Creation timestamp."),
    lastModifiedDateTime: s.string("Last modification timestamp."),
    deletedDateTime: s.nullableString("Deletion timestamp."),
    subject: s.nullableString("Channel post subject."),
    summary: s.nullableString("Notification summary."),
    importance: s.string("Message importance."),
    locale: s.string("Message locale."),
    webUrl: s.string("Microsoft Teams message URL."),
    from: rawObject,
    body: rawObject,
    channelIdentity: rawObject,
    chatId: s.string("Chat containing the message."),
    attachments: s.array(rawObject, { description: "Message attachments." }),
    mentions: s.array(rawObject, { description: "Message mentions." }),
    reactions: s.array(rawObject, { description: "Message reactions." }),
    replies: s.array(rawObject, { description: "Channel replies expanded with the root message." }),
    repliesNextLink: s.nullableString("Next-page URL for additional expanded replies."),
  },
  { description: "Microsoft Teams chat message resource." },
);
const messageWriteFields = {
  body: itemBody,
  subject: s.string("Channel post subject."),
  summary: s.string("Notification summary."),
  importance: s.stringEnum(["normal", "high", "urgent"], { description: "Message importance." }),
  locale: s.string("Message locale."),
  attachments: s.array(attachment, { description: "Message attachments." }),
  mentions: s.array(mention, { description: "Message mentions matching body markup." }),
};

const onlineMeetingId = s.nonEmptyString("Microsoft Graph online meeting ID.");
const dateTimeTimeZone = s.looseObject(
  {
    dateTime: s.string("Date and time, in the timeZone below."),
    timeZone: s.string("Time zone of dateTime; UTC for this provider's calendar reads."),
  },
  { description: "Microsoft Graph dateTimeTimeZone value." },
);
const emailAddress = s.looseObject(
  {
    name: s.string("Display name."),
    address: s.string("Email address."),
  },
  { description: "Microsoft Graph email address." },
);
const calendarEvent = s.looseObject(
  {
    id: s.nonEmptyString("Event ID. calendarView expands recurring meetings, so each occurrence has its own ID."),
    iCalUId: s.string("Event ID shared by every calendar holding the event, and by every occurrence of a series."),
    subject: s.nullableString("Event subject."),
    start: dateTimeTimeZone,
    end: dateTimeTimeZone,
    isOnlineMeeting: s.boolean("Whether the event carries online meeting details."),
    onlineMeeting: s.nullable(
      s.looseObject(
        { joinUrl: s.nullableString("Join URL of the online meeting.") },
        { description: "Online meeting details of the event." },
      ),
    ),
    seriesMasterId: s.nullableString("ID of the series master for an occurrence, or null for a single event."),
    organizer: s.looseObject({ emailAddress }, { description: "Event organizer." }),
    attendees: s.array(
      s.looseObject(
        {
          type: s.string("required, optional, or resource."),
          emailAddress,
          status: rawObject,
        },
        { description: "Event attendee." },
      ),
      { description: "Event attendees." },
    ),
  },
  { description: "Microsoft Graph calendar event, limited to the fields meeting records need." },
);
const onlineMeeting = s.looseObject(
  {
    id: s.nonEmptyString("Online meeting ID."),
    joinWebUrl: s.nullableString("Join URL of the online meeting."),
    subject: s.nullableString("Meeting subject."),
    startDateTime: s.nullableString("Scheduled start time."),
    endDateTime: s.nullableString("Scheduled end time."),
  },
  { description: "Microsoft Graph online meeting resource." },
);
const transcript = s.looseObject(
  {
    id: s.nonEmptyString("Transcript ID."),
    meetingId: s.string("Online meeting ID."),
    createdDateTime: s.string("Time the transcript was created."),
    endDateTime: s.nullableString("Time the transcript ended."),
    transcriptContentUrl: s.string("Graph URL of the transcript content."),
  },
  { description: "Microsoft Graph call transcript metadata." },
);
const aiInsight = s.object(
  {
    id: s.nonEmptyString("AI insight ID."),
    callId: s.nullableString("ID of the call the insight was generated for."),
    contentCorrelationId: s.nullableString(
      "ID that correlates the insight with the meeting's recording and transcript.",
    ),
    createdDateTime: s.nullableString("Time the insight was created."),
    endDateTime: s.nullableString("Time the insight ended."),
    meetingNotes: s.array(
      s.object(
        {
          title: s.nullableString("Note title."),
          text: s.nullableString("Note text."),
          subpoints: s.array(
            s.object(
              { title: s.nullableString("Subpoint title."), text: s.nullableString("Subpoint text.") },
              { required: ["title", "text"], description: "Meeting note subpoint." },
            ),
            { description: "Subpoints of the note." },
          ),
        },
        { required: ["title", "text", "subpoints"], description: "Meeting note." },
      ),
      { description: "AI-generated meeting notes." },
    ),
    actionItems: s.array(
      s.object(
        {
          title: s.nullableString("Action item title."),
          text: s.nullableString("Action item text."),
          ownerDisplayName: s.nullableString("Display name of the person the action item is assigned to."),
        },
        { required: ["title", "text", "ownerDisplayName"], description: "Meeting action item." },
      ),
      { description: "AI-generated action items." },
    ),
    viewpoint: s.nullable(rawObject),
  },
  {
    required: [
      "id",
      "callId",
      "contentCorrelationId",
      "createdDateTime",
      "endDateTime",
      "meetingNotes",
      "actionItems",
      "viewpoint",
    ],
    description: "Microsoft Graph Copilot AI insight of one meeting.",
  },
);

function input(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  return s.actionInput(properties, required, "Microsoft Teams action input.");
}

function paginated(itemName: string, itemSchema: JsonSchema): JsonSchema {
  return s.object(
    {
      [itemName]: s.array(itemSchema, { description: `Microsoft Graph ${itemName} results.` }),
      nextLink: s.nullableString("Next-page URL, or null when no page remains."),
    },
    { required: [itemName, "nextLink"], description: "Paginated Microsoft Teams response." },
  );
}

const actions: MicrosoftTeamsActionSource[] = [
  action(
    "get_current_user",
    "read",
    "Get the profile for the connected Microsoft work or school account.",
    microsoftTeamsProfileScopes,
    input({}),
    user,
  ),
  action(
    "list_joined_teams",
    "read",
    "List teams that the connected account has joined.",
    microsoftTeamsTeamScopes,
    input({ nextLink }),
    paginated("teams", team),
  ),
  action(
    "get_team",
    "read",
    "Get one Microsoft team by ID.",
    microsoftTeamsTeamScopes,
    input({ teamId, select }, ["teamId"]),
    team,
  ),
  action(
    "list_team_channels",
    "read",
    "List channels visible to the connected account in a team.",
    microsoftTeamsChannelScopes,
    input({ teamId, select, filter: s.string("OData filter expression."), nextLink }, ["teamId"]),
    paginated("channels", channel),
  ),
  action(
    "get_channel",
    "read",
    "Get one channel in a Microsoft team.",
    microsoftTeamsChannelScopes,
    input({ teamId, channelId, select }, ["teamId", "channelId"]),
    channel,
  ),
  action(
    "list_channel_messages",
    "read",
    "List channel posts with optionally expanded replies, or continue root-message or reply pagination.",
    microsoftTeamsChannelMessageReadScopes,
    input(
      {
        teamId,
        channelId,
        top: s.integer({ minimum: 1, maximum: 50, description: "Maximum root messages to return." }),
        includeReplies: s.boolean("Whether to expand replies on each root message."),
        nextLink,
      },
      ["teamId", "channelId"],
    ),
    paginated("messages", message),
  ),
  action(
    "list_chats",
    "read",
    "List chats that include the connected account.",
    microsoftTeamsChatReadScopes,
    input({
      top: s.integer({ minimum: 1, maximum: 50, description: "Maximum chats to return." }),
      filter: s.string("Supported Microsoft Graph chat filter."),
      orderby: s.string("Supported Microsoft Graph chat ordering."),
      expand: s.stringEnum(["members", "lastMessagePreview", "members,lastMessagePreview"], {
        description: "Related chat data to expand.",
      }),
      nextLink,
    }),
    paginated("chats", chat),
  ),
  action(
    "list_chat_messages",
    "read",
    "List messages from an existing one-on-one, group, or meeting chat.",
    microsoftTeamsChatReadScopes,
    input(
      {
        chatId,
        top: s.integer({ minimum: 1, maximum: 50, description: "Maximum messages to return." }),
        orderby: s.string("Supported Microsoft Graph message ordering."),
        filter: s.string("Supported Microsoft Graph message filter."),
        nextLink,
      },
      ["chatId"],
    ),
    paginated("messages", message),
  ),
  action(
    "send_channel_message",
    "write",
    "Send a new root message to a Microsoft Teams channel.",
    microsoftTeamsChannelMessageSendScopes,
    input({ teamId, channelId, ...messageWriteFields }, ["teamId", "channelId", "body"]),
    message,
  ),
  action(
    "reply_to_channel_message",
    "write",
    "Reply to an existing root message in a Microsoft Teams channel.",
    microsoftTeamsChannelMessageSendScopes,
    input({ teamId, channelId, messageId, ...messageWriteFields }, ["teamId", "channelId", "messageId", "body"]),
    message,
  ),
  action(
    "send_chat_message",
    "write",
    "Send a message to an existing one-on-one, group, or meeting chat.",
    microsoftTeamsChatMessageSendScopes,
    input({ chatId, ...messageWriteFields }, ["chatId", "body"]),
    message,
  ),
  action(
    "list_calendar_view",
    "read",
    "List the connected account's calendar events between two times, recurring meetings expanded into occurrences, with the fields needed to find each Teams meeting. Times in the result are UTC.",
    microsoftTeamsCalendarReadScopes,
    input(
      {
        startDateTime: s.dateTime("Window start, ISO 8601, such as 2026-11-01T00:00:00Z."),
        endDateTime: s.dateTime("Window end, ISO 8601, such as 2026-11-08T00:00:00Z."),
        top: s.integer("Events per page.", { minimum: 1, maximum: 1000 }),
        nextLink,
      },
      ["startDateTime", "endDateTime"],
    ),
    paginated("events", calendarEvent),
  ),
  action(
    "get_online_meeting_by_join_url",
    "read",
    "Find the connected account's online meeting by its join URL, such as a calendar event's onlineMeeting.joinUrl. Returns null when no meeting matches.",
    microsoftTeamsOnlineMeetingReadScopes,
    input({ joinUrl: s.url("Join URL of the Teams meeting.") }, ["joinUrl"]),
    s.object(
      { onlineMeeting: s.nullable(onlineMeeting) },
      { required: ["onlineMeeting"], description: "The matching online meeting." },
    ),
  ),
  action(
    "list_meeting_transcripts",
    "read",
    "List the transcripts of one online meeting the connected account can read. Needs tenant administrator consent.",
    microsoftTeamsTranscriptReadScopes,
    input({ onlineMeetingId, nextLink }, ["onlineMeetingId"]),
    paginated("transcripts", transcript),
  ),
  action(
    "get_transcript_content",
    "read",
    "Read one meeting transcript as WebVTT text with speaker names. Needs tenant administrator consent.",
    microsoftTeamsTranscriptReadScopes,
    input({ onlineMeetingId, transcriptId: s.nonEmptyString("Transcript ID.") }, ["onlineMeetingId", "transcriptId"]),
    s.object(
      {
        contentType: s.literal("text/vtt", { description: "Media type of content." }),
        content: s.string("Transcript text in WebVTT, with <v Speaker> voice tags."),
      },
      { required: ["contentType", "content"], description: "Transcript content." },
    ),
  ),
  action(
    "list_meeting_ai_insights",
    "read",
    "List the Microsoft 365 Copilot AI insights of one online meeting, each with its meeting notes and action items. Needs tenant administrator consent and a Copilot license for the user.",
    microsoftTeamsAiInsightReadScopes,
    input(
      {
        onlineMeetingId,
        userId: s.nonEmptyString(
          "Microsoft Entra object ID of the user whose view of the meeting to read. Defaults to the connected account.",
        ),
        nextLink,
      },
      ["onlineMeetingId"],
    ),
    paginated("insights", aiInsight),
  ),
];

export const microsoftTeamsActions: ActionDefinition[] = actions.map((source) => defineProviderAction(service, source));

function action(
  name: string,
  operationType: ActionDefinition["operationType"],
  description: string,
  scopes: string[],
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
): MicrosoftTeamsActionSource {
  return {
    name,
    operationType,
    description,
    requiredScopes: scopes,
    providerPermissions: scopes,
    inputSchema,
    outputSchema,
  };
}
