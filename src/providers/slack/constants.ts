export const slackConversationTypes = ["public_channel", "private_channel", "im", "mpim"] as const;
export const slackNormalizedConversationTypes = ["public_channel", "private_channel", "im", "mpim", "unknown"] as const;
/// `profile` adds the person's name to OpenID userInfo, so a linked account
/// is shown by name and not by its member id.
export const slackIdentityScopes: string[] = ["openid", "email", "profile"];

export type SlackNormalizedConversationType = (typeof slackNormalizedConversationTypes)[number];
