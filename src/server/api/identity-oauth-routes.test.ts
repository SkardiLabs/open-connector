import { afterEach, expect, it, vi } from "vitest";
import { createCatalogStore } from "../../catalog-store.ts";
import { provider as dropbox } from "../../providers/dropbox/definition.ts";
import { ProviderLoader } from "../../providers/provider-loader.ts";
import { createConnectApp } from "../connect-app.ts";
import { TransitFileService } from "../files/transit-files.ts";
import { AesGcmSecretCodec } from "../secrets/secret-codec.ts";
import { SqliteRuntimeDatabase } from "../storage/sqlite/runtime-store.ts";

afterEach(() => vi.unstubAllGlobals());

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
