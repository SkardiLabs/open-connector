const microsoftTeamsProviderScopes = {
  userRead: "User.Read",
  teamReadBasicAll: "Team.ReadBasic.All",
  channelReadBasicAll: "Channel.ReadBasic.All",
  channelMessageReadAll: "ChannelMessage.Read.All",
  channelMessageSend: "ChannelMessage.Send",
  chatRead: "Chat.Read",
  chatMessageSend: "ChatMessage.Send",
  offlineAccess: "offline_access",
  calendarsRead: "Calendars.Read",
  onlineMeetingsRead: "OnlineMeetings.Read",
  onlineMeetingTranscriptReadAll: "OnlineMeetingTranscript.Read.All",
  onlineMeetingAiInsightReadAll: "OnlineMeetingAiInsight.Read.All",
};

export const microsoftTeamsProfileScopes: string[] = [microsoftTeamsProviderScopes.userRead];
export const microsoftTeamsTeamScopes: string[] = [microsoftTeamsProviderScopes.teamReadBasicAll];
export const microsoftTeamsChannelScopes: string[] = [microsoftTeamsProviderScopes.channelReadBasicAll];
export const microsoftTeamsChannelMessageReadScopes: string[] = [microsoftTeamsProviderScopes.channelMessageReadAll];
export const microsoftTeamsChannelMessageSendScopes: string[] = [microsoftTeamsProviderScopes.channelMessageSend];
export const microsoftTeamsChatReadScopes: string[] = [microsoftTeamsProviderScopes.chatRead];
export const microsoftTeamsChatMessageSendScopes: string[] = [microsoftTeamsProviderScopes.chatMessageSend];
export const microsoftTeamsOAuthScopes: string[] = [
  microsoftTeamsProviderScopes.userRead,
  microsoftTeamsProviderScopes.teamReadBasicAll,
  microsoftTeamsProviderScopes.channelReadBasicAll,
  microsoftTeamsProviderScopes.channelMessageReadAll,
  microsoftTeamsProviderScopes.channelMessageSend,
  microsoftTeamsProviderScopes.chatRead,
  microsoftTeamsProviderScopes.chatMessageSend,
  microsoftTeamsProviderScopes.offlineAccess,
];
export const microsoftTeamsCalendarReadScopes: string[] = [microsoftTeamsProviderScopes.calendarsRead];
export const microsoftTeamsOnlineMeetingReadScopes: string[] = [microsoftTeamsProviderScopes.onlineMeetingsRead];
export const microsoftTeamsTranscriptReadScopes: string[] = [
  microsoftTeamsProviderScopes.onlineMeetingTranscriptReadAll,
];
export const microsoftTeamsAiInsightReadScopes: string[] = [microsoftTeamsProviderScopes.onlineMeetingAiInsightReadAll];

/**
 * Meeting-record permissions. They are optional so existing connections keep their consent:
 * OnlineMeetingTranscript.Read.All and OnlineMeetingAiInsight.Read.All need tenant administrator consent.
 */
export const microsoftTeamsMeetingOptionalScopes: string[] = [
  microsoftTeamsProviderScopes.calendarsRead,
  microsoftTeamsProviderScopes.onlineMeetingsRead,
  microsoftTeamsProviderScopes.onlineMeetingTranscriptReadAll,
  microsoftTeamsProviderScopes.onlineMeetingAiInsightReadAll,
];
