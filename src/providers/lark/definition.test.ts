import { describe, expect, it } from "vitest";
import { provider as feishuProvider } from "../feishu/definition.ts";
import { provider } from "./definition.ts";

describe("Lark provider definition", () => {
  it("authenticates against Lark's hosts, not Feishu's", () => {
    expect(provider.service).toBe("lark");
    expect(provider.displayName).toBe("Lark");
    expect(provider.homepageUrl).toBe("https://www.larksuite.com");
    expect(provider.auth).toEqual([
      expect.objectContaining({
        type: "oauth2",
        authorizationUrl: "https://accounts.larksuite.com/open-apis/authen/v1/authorize",
        tokenUrl: "https://open.larksuite.com/open-apis/authen/v2/oauth/token",
        tokenEndpointAuthMethod: "client_secret_post",
        tokenRequestFormat: "json",
      }),
    ]);
  });

  it("leaves the Feishu provider's auth hosts unchanged", () => {
    expect(feishuProvider.auth).toEqual([
      expect.objectContaining({
        authorizationUrl: "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
        tokenUrl: "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
      }),
    ]);
  });

  it("exposes the Feishu action set and scopes under lark.* ids", () => {
    expect(provider.actions.map((action) => action.name)).toEqual(feishuProvider.actions.map((action) => action.name));
    expect(provider.actions.every((action) => action.id === `lark.${action.name}`)).toBe(true);
    for (const name of ["list_drive_files", "search_documents", "list_chats", "get_current_user"]) {
      expect(provider.actions.some((action) => action.id === `lark.${name}`)).toBe(true);
    }
    const [larkAuth] = provider.auth;
    const [feishuAuth] = feishuProvider.auth;
    expect(larkAuth?.type === "oauth2" && larkAuth.scopes).toEqual(feishuAuth?.type === "oauth2" && feishuAuth.scopes);
  });
});
