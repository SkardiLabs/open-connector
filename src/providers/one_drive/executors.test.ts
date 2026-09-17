import type { ExecutionContext, ResolvedCredential, TransitFileStore } from "../../core/types.ts";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction } from "../../core/execution.ts";
import { setDefaultGuardedFetchDnsLookup } from "../../core/guarded-fetch.ts";
import { provider } from "./definition.ts";
import { executors } from "./executors.ts";

interface CapturedRequest {
  url: URL;
  authorization: string | null;
  signal: AbortSignal | null;
}

const oauthCredential: Extract<ResolvedCredential, { authType: "oauth2" }> = {
  authType: "oauth2",
  accessToken: "onedrive-access-token",
  tokenType: "Bearer",
  profile: { accountId: "onedrive:test", displayName: "OneDrive test", grantedScopes: [] },
  metadata: {},
};

beforeEach(() => {
  setDefaultGuardedFetchDnsLookup(null);
});

afterEach(() => {
  setDefaultGuardedFetchDnsLookup(undefined);
  vi.unstubAllGlobals();
});

describe("OneDrive transit downloads", () => {
  it("follows the guarded content redirect and stores exact file bytes", async () => {
    const content = new Uint8Array([79, 110, 101, 0, 255]);
    const requests = stubResponses([
      Response.json({
        id: "item-1",
        name: "notes.txt",
        size: content.length,
        file: { mimeType: "text/plain" },
      }),
      new Response(null, {
        status: 302,
        headers: { location: "https://public.dm.files.1drv.com/download/item-1" },
      }),
      new Response(Uint8Array.from(content), { headers: { "content-type": "text/plain; charset=utf-8" } }),
    ]);
    const { store, create } = createTransitFileStore(1024);
    const controller = new AbortController();

    const result = await executeOneDriveAction("download_file", { itemId: "item-1" }, store, controller.signal);

    expect(result).toEqual({
      ok: true,
      output: {
        fileId: "item-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: content.length,
        file: {
          fileId: "transit-file-1",
          downloadUrl: "http://localhost/api/files/transit-file-1",
          sizeBytes: content.length,
          name: "notes.txt",
          mimeType: "text/plain",
        },
      },
    });
    expect(requests).toHaveLength(3);
    expect(requests[0]?.url.pathname).toBe("/v1.0/me/drive/items/item-1");
    expect(requests[0]?.url.searchParams.get("$select")).toBe("id,name,size,file,folder");
    expect(requests[1]?.url.pathname).toBe("/v1.0/me/drive/items/item-1/content");
    expect(requests[0]?.authorization).toBe("Bearer onedrive-access-token");
    expect(requests[1]?.authorization).toBe("Bearer onedrive-access-token");
    expect(requests[2]?.authorization).toBeNull();
    expect(requests[0]?.signal).toBe(controller.signal);
    expect(requests[1]?.signal).toBe(controller.signal);
    expect(create).toHaveBeenCalledOnce();
    expect(new Uint8Array(await create.mock.calls[0]![0].arrayBuffer())).toEqual(content);
  });

  it("stores converted content with the converted extension and MIME type", async () => {
    const content = new Uint8Array([37, 80, 68, 70]);
    const requests = stubResponses([
      Response.json({
        id: "item-2",
        name: "proposal.docx",
        size: 10_000,
        file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
      }),
      new Response(Uint8Array.from(content), { headers: { "content-type": "application/octet-stream" } }),
    ]);
    const { store } = createTransitFileStore(16);

    const result = await executeOneDriveAction("download_item_as_format", { itemId: "item-2", format: "pdf" }, store);

    expect(result).toMatchObject({
      ok: true,
      output: {
        fileId: "item-2",
        name: "proposal.pdf",
        mimeType: "application/pdf",
        sizeBytes: content.length,
        file: { name: "proposal.pdf", mimeType: "application/pdf", sizeBytes: content.length },
      },
    });
    expect(requests[1]?.url.searchParams.get("format")).toBe("pdf");
  });

  it("supports path-based downloads with the same transit result", async () => {
    const requests = stubResponses([
      Response.json({ id: "item-3", name: "report.csv", size: 2, file: { mimeType: "text/csv" } }),
      new Response("ok", { headers: { "content-type": "text/csv" } }),
    ]);
    const { store } = createTransitFileStore(16);

    const result = await executeOneDriveAction(
      "download_file_by_path",
      { itemPath: "/reports/report.csv", fileName: "renamed.csv" },
      store,
    );

    expect(result).toMatchObject({
      ok: true,
      output: { fileId: "item-3", name: "report.csv", file: { name: "renamed.csv" } },
    });
    expect(requests[0]?.url.pathname).toBe("/v1.0/me/drive/root:/reports/report.csv:");
    expect(requests[1]?.url.pathname).toBe("/v1.0/me/drive/root:/reports/report.csv:/content");
  });

  it("rejects a reported raw file size above the transit limit before downloading content", async () => {
    const requests = stubResponses([
      Response.json({ id: "item-4", name: "large.bin", size: 3, file: { mimeType: "application/octet-stream" } }),
    ]);
    const { store, create } = createTransitFileStore(2);

    const result = await executeOneDriveAction("download_file", { itemId: "item-4" }, store);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "OneDrive download exceeds 2 bytes",
        details: { status: 413 },
      },
    });
    expect(requests).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
  });

  it("enforces the transit limit when the response exceeds reported metadata", async () => {
    stubResponses([
      Response.json({ id: "item-5", name: "growing.bin", size: 1, file: { mimeType: "application/octet-stream" } }),
      new Response(Uint8Array.from([1, 2, 3])),
    ]);
    const { store, create } = createTransitFileStore(2);

    const result = await executeOneDriveAction("download_file", { itemId: "item-5" }, store);

    expect(result).toMatchObject({
      ok: false,
      error: { message: "OneDrive download exceeds 2 bytes", details: { status: 413 } },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    ["download_file", { itemId: "item-1" }],
    ["download_file_by_path", { itemPath: "/notes.txt" }],
    ["download_item_as_format", { itemId: "item-1", format: "pdf" }],
  ] as const)("returns a clear error when %s has no transit storage", async (actionName, input) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const result = await executeOneDriveAction(actionName, input);

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_input",
        message: "one_drive downloads require local transit file storage",
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("OneDrive item permissions", () => {
  it("reads the permissions of an item by id, and reports the end of the list", async () => {
    const requests = stubResponses([
      Response.json({
        value: [{ id: "perm-1", roles: ["read"], grantedToV2: { user: { id: "u1", displayName: "Ada" } } }],
      }),
    ]);

    const result = await executeOneDriveAction("list_item_permissions", { itemId: "item-1" });

    expect(requests[0]!.url.pathname).toBe("/v1.0/me/drive/items/item-1/permissions");
    expect(result).toEqual({
      ok: true,
      output: {
        items: [{ id: "perm-1", roles: ["read"], grantedToV2: { user: { id: "u1", displayName: "Ada" } } }],
        // Absent `@odata.nextLink` is the end of the list, and it is reported
        // as an explicit null rather than an omitted key: a consumer cannot
        // tell an omitted cursor from a response shape it failed to read.
        nextLink: null,
      },
    });
  });

  it("returns a personal drive's permission unchanged, both spellings included", async () => {
    // Measured: a personal OneDrive returns `grantedTo` and omits
    // `grantedToV2` entirely, while a work or school drive does the opposite.
    //
    // What this pins is the ROUND TRIP — a personal-shaped permission reaches
    // the caller with its attribution intact. It does NOT pin the schema
    // declaration: `permission` is a `looseObject`, so an undeclared field
    // passes through anyway and removing `grantedTo` from `actions.ts` leaves
    // this test green (checked). The declaration earns its place in the
    // published catalog, which is what an SDK consumer reads to learn the
    // field exists at all.
    stubResponses([
      Response.json({
        value: [
          {
            id: "perm-2",
            roles: ["owner"],
            grantedTo: { user: { id: "u2", displayName: "Grace" } },
            inheritedFrom: { driveId: "d1", id: "parent-1", path: "/drive/root:" },
          },
        ],
      }),
    ]);

    const result = await executeOneDriveAction("list_item_permissions", { itemId: "item-2" });

    expect(result).toMatchObject({
      ok: true,
      output: {
        items: [
          {
            grantedTo: { user: { id: "u2", displayName: "Grace" } },
            // `inheritedFrom` is personal-only and is the difference between
            // "shared here" and "shared above"; dropping it would make a
            // folder's own sharing indistinguishable from its parent's.
            inheritedFrom: { id: "parent-1" },
          },
        ],
      },
    });
  });

  it("keeps the identities a specific-people link was shared with", async () => {
    stubResponses([
      Response.json({
        value: [
          {
            id: "perm-3",
            roles: ["read"],
            link: { type: "view", scope: "users" },
            grantedToIdentitiesV2: [{ user: { id: "u3", displayName: "Alan" } }],
          },
        ],
      }),
    ]);

    const result = await executeOneDriveAction("list_item_permissions", { itemId: "item-3" });

    expect(result).toMatchObject({
      ok: true,
      output: {
        items: [{ grantedToIdentitiesV2: [{ user: { id: "u3", displayName: "Alan" } }] }],
      },
    });
  });

  it("addresses an item by path, and a named drive", async () => {
    const byPath = stubResponses([Response.json({ value: [] })]);
    await executeOneDriveAction("list_item_permissions", { itemPath: "/Reports/Q3" });
    expect(byPath[0]!.url.pathname).toBe("/v1.0/me/drive/root:/Reports/Q3:/permissions");

    const byDrive = stubResponses([Response.json({ value: [] })]);
    await executeOneDriveAction("list_item_permissions", { driveId: "drive-9", itemId: "item-4" });
    expect(byDrive[0]!.url.pathname).toBe("/v1.0/drives/drive-9/items/item-4/permissions");
  });

  it("follows a permission nextLink and refuses one that points elsewhere", async () => {
    const followed = stubResponses([Response.json({ value: [{ id: "perm-4", roles: ["read"] }] })]);
    const ok = await executeOneDriveAction("list_item_permissions", {
      itemId: "item-5",
      nextLink: "https://graph.microsoft.com/v1.0/me/drive/items/item-5/permissions?$skiptoken=abc",
    });
    expect(ok).toMatchObject({ ok: true });
    expect(followed[0]!.url.searchParams.get("$skiptoken")).toBe("abc");

    // The cursor is a string Microsoft Graph put in a response body. Following
    // it unchecked would let one response redirect this action at any other
    // endpoint the token can reach — a token minted to read one folder's ACL
    // reading the signed-in user's mail, say.
    //
    // BOTH shapes are refused, and the second is the one that matters. A path
    // outside the drive is caught by `readDrivePathSuffix` returning null, so
    // a test using only that would pass with the endpoint check deleted
    // entirely (checked). The children endpoint is a drive path that reaches
    // the endpoint check, and it is the confusion this policy exists for:
    // three paginated actions share one request builder.
    for (const elsewhere of [
      "https://graph.microsoft.com/v1.0/me/messages",
      "https://graph.microsoft.com/v1.0/me/drive/items/item-5/children",
    ]) {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const refused = await executeOneDriveAction("list_item_permissions", {
        itemId: "item-5",
        nextLink: elsewhere,
      });
      expect(refused, elsewhere).toMatchObject({
        ok: false,
        error: { message: "nextLink must target OneDrive permission pagination endpoints" },
      });
      expect(fetch, elsewhere).not.toHaveBeenCalled();
    }
  });

  it("requires an item to ask about", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const result = await executeOneDriveAction("list_item_permissions", {});

    expect(result).toMatchObject({ ok: false, error: { message: "itemId or itemPath is required" } });
    expect(fetch).not.toHaveBeenCalled();
  });
});

function stubResponses(responses: Response[]): CapturedRequest[] {
  const requests: CapturedRequest[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push({
      url: new URL(request.url),
      authorization: request.headers.get("authorization"),
      signal: init?.signal ?? (input instanceof Request ? input.signal : null),
    });
    const response = responses.shift();
    if (!response) {
      throw new Error(`Unexpected OneDrive request to ${request.url}`);
    }
    return response;
  });
  return requests;
}

function createTransitFileStore(maxBytes: number): {
  store: TransitFileStore;
  create: ReturnType<typeof vi.fn<TransitFileStore["create"]>>;
} {
  const create = vi.fn<TransitFileStore["create"]>(async (file) => ({
    fileId: "transit-file-1",
    downloadUrl: "http://localhost/api/files/transit-file-1",
    sizeBytes: file.size,
    name: file.name,
    mimeType: file.type,
  }));
  return {
    create,
    store: {
      maxBytes,
      create,
      async read() {
        throw new Error("read is not expected in this test");
      },
      async delete() {
        return false;
      },
    },
  };
}

async function executeOneDriveAction(
  actionName: string,
  input: Record<string, unknown>,
  transitFiles?: TransitFileStore,
  signal?: AbortSignal,
) {
  const context: ExecutionContext = {
    getCredential: async (service) => {
      expect(service).toBe("one_drive");
      return oauthCredential;
    },
  };
  if (transitFiles) {
    context.transitFiles = transitFiles;
  }
  if (signal) {
    context.signal = signal;
  }
  return executeAction(
    provider.actions.find((action) => action.name === actionName)!,
    executors[`one_drive.${actionName}`],
    input,
    context,
  );
}
