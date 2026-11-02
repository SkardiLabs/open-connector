import type { ProviderDefinition } from "../../core/types.ts";

import { dropboxActions } from "./actions.ts";
import { dropboxOAuthScopes } from "./scopes.ts";

const service = "dropbox";

/**
 * Dropbox provider backed by Dropbox API v2.
 */
export const provider: ProviderDefinition = {
  service,
  displayName: "Dropbox",
  categories: ["Storage", "Productivity"],
  authTypes: ["oauth2"],
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://www.dropbox.com/oauth2/authorize",
      tokenUrl: "https://api.dropboxapi.com/oauth2/token",
      revocationUrl: "https://api.dropboxapi.com/2/auth/token/revoke",
      revocationRequestFormat: "bearer",
      scopes: dropboxOAuthScopes,
      identityScopes: ["account_info.read"],
      identityAuthorizationParams: { token_access_type: "online" },
      tokenEndpointAuthMethod: "client_secret_post",
      authorizationParams: {
        token_access_type: "offline",
      },
    },
  ],
  homepageUrl: "https://www.dropbox.com",
  actions: dropboxActions,
};
