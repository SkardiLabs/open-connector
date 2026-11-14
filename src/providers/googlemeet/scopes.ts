import { googleIdentityScopes } from "../googleads/scopes.ts";

export const googleMeetSpaceCreatedScope = "https://www.googleapis.com/auth/meetings.space.created";
export const googleMeetSpaceReadonlyScope = "https://www.googleapis.com/auth/meetings.space.readonly";
export const googleMeetSpaceSettingsScope = "https://www.googleapis.com/auth/meetings.space.settings";

export const googleMeetCreateScopes: string[] = [googleMeetSpaceCreatedScope];
export const googleMeetReadScopes: string[] = [googleMeetSpaceReadonlyScope];
export const googleMeetSettingsScopes: string[] = [googleMeetSpaceSettingsScope];
/** The identity scopes Google's userinfo needs for a subject and an email address. */
export const googleMeetCurrentUserScopes: string[] = ["openid", "email"];

export const googleMeetOAuthScopes: string[] = [
  googleMeetSpaceCreatedScope,
  googleMeetSpaceReadonlyScope,
  googleMeetSpaceSettingsScope,
  ...googleIdentityScopes,
];
