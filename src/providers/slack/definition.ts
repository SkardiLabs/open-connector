import type { ProviderDefinition } from "../../core/types.ts";

import { slackActions } from "./actions.ts";
import { slackUserOAuthScopes } from "./scopes.ts";

const service = "slack";

/**
 * User-authorized Slack provider backed by the Slack Web API.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Slack",
  categories: ["Communication", "Productivity"],
  authTypes: ["oauth2", "api_key"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://slack.com/oauth/v2_user/authorize",
      tokenUrl: "https://slack.com/api/oauth.v2.user.access",
      refreshTokenUrl: "https://slack.com/api/oauth.v2.access",
      scopes: slackUserOAuthScopes,
      scopeSeparator: ",",
      tokenEndpointAuthMethod: "client_secret_post",
    },
    {
      type: "api_key",
      label: "Bot token",
      placeholder: "xoxb-...",
      description:
        "Slack bot or user token used with the Authorization Bearer header. Create a Slack app, install it to the workspace, then copy the bot token from OAuth & Permissions.",
    },
  ],
  homepageUrl: "https://slack.com",
  actions: slackActions,
};
