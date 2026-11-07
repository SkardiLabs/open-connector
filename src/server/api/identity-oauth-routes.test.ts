import { afterEach, expect, it, vi } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { OAUTH_STATE_MAX_AGE_MS } from "../../oauth/oauth-flow-service.ts";
import { provider as dropbox } from "../../providers/dropbox/definition.ts";
import { ProviderLoader } from "../../providers/provider-loader.ts";
import { provider as slack } from "../../providers/slack/definition.ts";
import { createConnectApp } from "../connect-app.ts";
import { TransitFileService } from "../files/transit-files.ts";
import { AesGcmSecretCodec } from "../secrets/secret-codec.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite/runtime-store.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// Authored provider responses exercise the real HTTP routes and OAuth lifecycle.
it.each([200, 503])("revokes only a temporary Dropbox identity token (provider status %s)", async (revokeStatus) => {
  const database = new SqliteRuntimeDatabase(":memory:");
  try {
    await database.oauthClientConfigStore.set({
      service: "dropbox",
      clientId: "installed-app",
      clientSecret: "app-secret",
      extra: {},
      secretExtra: {},
    });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://api.dropboxapi.com/oauth2/token") {
        const body = init!.body as URLSearchParams;
        expect(body.get("redirect_uri")).toBe("https://connector.example/oauth/callback");
        return Response.json(
          body.get("code") === "source-code"
            ? { access_token: "source-access", refresh_token: "source-refresh", token_type: "Bearer" }
            : { access_token: "identity-access", token_type: "Bearer" },
        );
      }
      if (url === "https://api.dropboxapi.com/2/users/get_current_account") {
        return Response.json({ account_id: "dbid:test", name: { display_name: "Test reader" } });
      }
      expect(url).toBe("https://api.dropboxapi.com/2/auth/token/revoke");
      expect(init!.method).toBe("POST");
      expect(new Headers(init!.headers).get("authorization")).toBe("Bearer identity-access");
      expect(init!.body).toBeUndefined();
      return new Response(null, { status: revokeStatus });
    });
    vi.stubGlobal("fetch", fetcher);
    const { app } = await createConnectApp({
      catalog: createCatalogStore([{ ...dropbox, actions: [] }]),
      runtimeDatabase: database,
      providerLoader: new ProviderLoader({ dropbox: () => import("../../providers/dropbox/executors.ts") }),
      transitFiles: new TransitFileService({
        rootDir: ".tmp/identity-oauth-tests",
        publicOrigin: "https://connector.example",
        ttlSeconds: 60,
        maxBytes: 1024,
      }),
      publicOrigin: "https://connector.example",
      secretCodec: new AesGcmSecretCodec("identity-oauth-test-key"),
      adminToken: "admin",
      oauthResultOrigins: ["https://gateway.example"],
    });
    const request = (path: string, method = "GET", body?: unknown) =>
      app.request(path, {
        method,
        headers: { "content-type": "application/json", authorization: "Bearer admin" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const start = async (connectionName: string, linkOnly?: unknown) => {
      const response = await request("/api/oauth/authorizations", "POST", {
        service: "dropbox",
        connectionName,
        linkOnly,
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const source = await start("binding_source");
    expect(new URL(source.authorizationUrl).searchParams.get("token_access_type")).toBe("offline");
    expect((await app.request(`/oauth/callback?state=${source.state}&code=source-code`)).status).toBe(200);
    const installed = await database.connectionStore.get("dropbox", "binding_source");
    expect(installed?.credential).toMatchObject({ accessToken: "source-access", refreshToken: "source-refresh" });
    const linkOnly = {
      clientFromConnection: "binding_source",
      connectionAlias: "selected",
      connectionVersionId: "accepted-version",
      requestedScopes: ["account_info.read"],
      returnUri: "https://gateway.example/links/callback",
      returnState: "signed-existing-state",
    };
    for (const returnUri of [
      "https://elsewhere.example/links/callback",
      "https://gateway.example/links/callback/extra",
      "https://gateway.example/links/callback?next=elsewhere",
    ]) {
      expect(
        (
          await request("/api/oauth/authorizations", "POST", {
            service: "dropbox",
            connectionName: "link_invalid",
            linkOnly: { ...linkOnly, returnUri },
          })
        ).status,
      ).toBe(400);
    }
    // Keep the old exact hand-back valid while the gateway rolls forward.
    const legacy = await start("link_legacy", {
      ...linkOnly,
      returnUri: "https://gateway.example/links/dropbox/callback",
    });
    const refused = await app.request(`/oauth/callback?state=${legacy.state}&error=access_denied`);
    expect(new URL(refused.headers.get("location")!).pathname).toBe("/links/dropbox/callback");
    const identity = await start("link_identity", linkOnly);
    const authorize = new URL(identity.authorizationUrl);
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://connector.example/oauth/callback");
    expect(authorize.searchParams.get("token_access_type")).toBe("online");
    expect(authorize.searchParams.get("scope")).toBe("account_info.read");
    const completed = await app.request(`/oauth/callback?state=${identity.state}&code=identity-code`);
    expect(completed.status).toBe(302);
    const handBack = new URL(completed.headers.get("location")!);
    expect(handBack.pathname).toBe("/links/callback");
    expect(handBack.searchParams.get("state")).toBe(linkOnly.returnState);
    expect(handBack.searchParams.get("code")).toBe(identity.state);
    const proof = await request("/api/connections?service=dropbox&connectionName=link_identity");
    expect(await proof.json()).toMatchObject([
      {
        oauthAuthorizationId: identity.state,
        linkOnly: {
          clientFromConnection: linkOnly.clientFromConnection,
          connectionAlias: linkOnly.connectionAlias,
          connectionVersionId: linkOnly.connectionVersionId,
          returnState: linkOnly.returnState,
        },
      },
    ]);
    const deleted = await request("/api/connections/dropbox", "DELETE", {
      connectionName: "link_identity",
      revoke: true,
    });
    expect(await deleted.json()).toMatchObject({
      configured: false,
      revoked: revokeStatus === 200 ? "done" : "failed",
    });
    expect(await database.connectionStore.get("dropbox", "link_identity")).toBeUndefined();
    expect(await database.connectionStore.get("dropbox", "binding_source")).toEqual(installed);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/auth/token/revoke"))).toHaveLength(1);
  } finally {
    database.close();
  }
});

it("keeps Slack OpenID proof separate from content and disposes only its temporary grant", async () => {
  const query = "?tenant=acme";
  const database = new SqliteRuntimeDatabase(":memory:");
  const redirectUri = `https://connector.example/oauth/callback${query}`;
  const userInfo = {
    ok: true,
    sub: "U456",
    "https://slack.com/user_id": "U456",
    "https://slack.com/team_id": "T123",
  };
  let identityPayload: unknown = userInfo;
  let identityToken = { ok: true, access_token: "identity-access", token_type: "Bearer" };
  let revokePayload: unknown = { ok: true, revoked: true };
  try {
    await database.oauthClientConfigStore.set({
      service: "slack",
      clientId: "installed-app",
      clientSecret: "app-secret",
      redirectUri,
      extra: {},
      secretExtra: {},
    });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const bearer = new Headers(init?.headers).get("authorization");
      if (url === "https://slack.com/api/oauth.v2.user.access") {
        expect((init!.body as URLSearchParams).get("code")).toBe("source-code");
        return Response.json({
          access_token: "source-access",
          token_type: "user",
          scope: "channels:read,users:read",
        });
      }
      if (url === "https://slack.com/api/auth.test") {
        expect(bearer).toBe("Bearer source-access");
        return Response.json({ ok: true, team_id: "T123", user_id: "U123" });
      }
      if (url === "https://slack.com/api/openid.connect.token") {
        const body = init!.body as URLSearchParams;
        expect(body.get("redirect_uri")).toBe(redirectUri);
        expect(body.get("client_id")).toBe("installed-app");
        return Response.json(identityToken);
      }
      if (url === "https://slack.com/api/openid.connect.userInfo") {
        expect(init?.method).toBe("POST");
        expect(new Headers(init?.headers).get("content-type")).toBe("application/x-www-form-urlencoded");
        expect(init?.body).toBe("");
        expect(bearer).toBe(`Bearer ${identityToken.access_token}`);
        return Response.json(identityPayload);
      }
      expect(url).toBe("https://slack.com/api/auth.revoke");
      expect(bearer).toBe(`Bearer ${identityToken.access_token}`);
      expect(init?.body).toBeUndefined();
      return Response.json(revokePayload);
    });
    vi.stubGlobal("fetch", fetcher);
    const { app, saasCleanup } = await createConnectApp({
      catalog: createCatalogStore([slack], { executableActionIds: ["slack.get_current_user"] }),
      runtimeDatabase: database,
      providerLoader: new ProviderLoader({ slack: () => import("../../providers/slack/executors.ts") }),
      transitFiles: new TransitFileService({
        rootDir: ".tmp/identity-oauth-tests",
        publicOrigin: "https://connector.example",
        ttlSeconds: 60,
        maxBytes: 1024,
      }),
      publicOrigin: "https://connector.example",
      secretCodec: new AesGcmSecretCodec("identity-oauth-test-key"),
      adminToken: "admin",
      oauthResultOrigins: ["https://gateway.example"],
    });
    const request = (path: string, method = "GET", body?: unknown) =>
      app.request(path, {
        method,
        headers: { "content-type": "application/json", authorization: "Bearer admin" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const start = async (connectionName: string, linkOnly?: unknown) => {
      const response = await request("/api/oauth/authorizations", "POST", {
        service: "slack",
        connectionName,
        linkOnly,
      });
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    };
    const source = await start("binding_source");
    const contentConsent = new URL(source.authorizationUrl);
    expect(contentConsent.pathname).toBe("/oauth/v2_user/authorize");
    expect(contentConsent.searchParams.get("scope")).not.toContain("openid");
    expect((await app.request(`/oauth/callback?state=${source.state}&code=source-code`)).status).toBe(200);
    const installed = await database.connectionStore.get("slack", "binding_source");
    expect(installed?.credential).toMatchObject({ accessToken: "source-access", profile: { accountId: "U123" } });
    const linkOnly = {
      clientFromConnection: "binding_source",
      connectionAlias: "selected",
      connectionVersionId: "accepted-version",
      requestedScopes: ["openid", "email"],
      returnUri: "https://gateway.example/links/callback",
      returnState: "signed-state",
    };
    for (const requestedScopes of [["openid", "channels:read"], ["email"]]) {
      const refused = await request("/api/oauth/authorizations", "POST", {
        service: "slack",
        connectionName: "link_invalid_scopes",
        linkOnly: { ...linkOnly, requestedScopes },
      });
      expect(refused.status).toBe(400);
    }
    const complete = (state: string) =>
      app.request(`/oauth/callback${query}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ state, code: "identity-code" }),
      });
    for (const [index, payload] of [
      { ok: true, revoked: true },
      { ok: true, revoked: false },
      { ok: false, revoked: true },
      { revoked: true },
      { ok: "true", revoked: true },
      { ok: null, revoked: true },
      { ok: true, revoked: true, error: "invalid_auth" },
      { ok: true },
      {},
      { ok: true, revoked: "true" },
      null,
    ].entries()) {
      revokePayload = payload;
      const name = `link_identity_${index}`;
      const identity = await start(name, linkOnly);
      const consent = new URL(identity.authorizationUrl);
      expect(consent.pathname).toBe("/openid/connect/authorize");
      expect(consent.searchParams.get("client_id")).toBe(contentConsent.searchParams.get("client_id"));
      expect(consent.searchParams.get("scope")).toBe("openid email");
      expect(consent.searchParams.get("response_mode")).toBe("form_post");
      const completed = await complete(identity.state);
      expect(completed.status).toBe(302);
      expect(new URL(completed.headers.get("location")!).searchParams.get("code")).toBe(identity.state);
      const result = await request("/v1/actions/slack.get_current_user", "POST", { input: {}, connectionName: name });
      expect(await result.json()).toMatchObject({
        success: true,
        data: { teamId: "T123", userId: "U456", isBot: false },
      });
      const deleted = await request("/api/connections/slack", "DELETE", { connectionName: name, revoke: true });
      expect(await deleted.json()).toMatchObject({ configured: false, revoked: index === 0 ? "done" : "failed" });
      expect(await database.connectionStore.get("slack", name)).toBeUndefined();
      expect(await database.connectionStore.get("slack", "binding_source")).toEqual(installed);
    }
    // A consumer that loses the callback response leaves the existing cleanup
    // marker. Expiry must retry disposal without losing its only credential.
    const abandoned = await start("link_abandoned", { ...linkOnly, requestedScopes: ["openid"] });
    expect(new URL(abandoned.authorizationUrl).searchParams.get("scope")).toBe("openid");
    expect((await complete(abandoned.state)).status).toBe(302);
    const temporary = await database.connectionStore.get("slack", "link_abandoned");
    expect(temporary).toMatchObject({ credential: { accessToken: "identity-access" } });
    const generation = await database.connectionStore.getRetirementGeneration("slack", "link_abandoned");
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + OAUTH_STATE_MAX_AGE_MS + 1000);
    const beforeFreshConsent = fetcher.mock.calls.length;
    await start("binding_next");
    expect(fetcher).toHaveBeenCalledTimes(beforeFreshConsent);
    expect(await database.connectionStore.get("slack", "link_abandoned")).toEqual(temporary);
    revokePayload = { ok: true, revoked: false };
    await saasCleanup.run();
    expect(await database.connectionStore.get("slack", "link_abandoned")).toEqual(temporary);
    expect(await database.connectionStore.getRetirementGeneration("slack", "link_abandoned")).toBe(generation);
    revokePayload = { ok: true, revoked: true };
    await saasCleanup.run();
    expect(await database.connectionStore.get("slack", "link_abandoned")).toBeUndefined();
    expect(await database.oauthStateStore.take(`cleanup:${abandoned.state}`)).toBeUndefined();
    expect(await database.connectionStore.get("slack", "binding_source")).toEqual(installed);
    clock.mockRestore();
    revokePayload = { ok: true, revoked: true };
    for (const [index, payload] of [
      { ...userInfo, sub: "U999" },
      { ...userInfo, "https://slack.com/team_id": null },
      { ...userInfo, "https://slack.com/user_id": 42 },
      { ok: false },
    ].entries()) {
      identityPayload = payload;
      const name = `link_malformed_${index}`;
      const identity = await start(name, linkOnly);
      const before = fetcher.mock.calls.filter(([url]) => String(url).endsWith("auth.revoke")).length;
      const response = await complete(identity.state);
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("provider_error");
      expect(await database.connectionStore.get("slack", name)).toBeUndefined();
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("auth.revoke"))).toHaveLength(before + 1);
    }
    identityPayload = userInfo;
    for (const token of [
      { ok: false, access_token: "identity-error-token", token_type: "Bearer" },
      { ok: true, access_token: "xoxb-bot-only", token_type: "bot" },
    ]) {
      identityToken = token;
      const identity = await start(`link_rejected_${token.ok}`, linkOnly);
      const before = fetcher.mock.calls.filter(([url]) => String(url).endsWith("openid.connect.userInfo")).length;
      const response = await complete(identity.state);
      expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe("provider_error");
      expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("openid.connect.userInfo"))).toHaveLength(
        before,
      );
    }
    expect(await database.connectionStore.get("slack", "binding_source")).toEqual(installed);
  } finally {
    database.close();
  }
});
