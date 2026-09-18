import type { ActionDefinition } from "../../core/types.ts";

import { describe, expect, it } from "vitest";
import { provider } from "./definition.ts";

function action(name: string): ActionDefinition {
  const found = provider.actions.find((candidate) => candidate.name === name);
  expect(found, `${name} must remain in the Feishu catalog`).toBeDefined();
  return found!;
}

describe("Feishu provider definition", () => {
  it("requests the provider-enforced folder-list permission", () => {
    expect(action("list_drive_files").requiredScopes).toEqual(["space:document:retrieve"]);
    expect(action("list_drive_files").providerPermissions).toEqual(["space:document:retrieve"]);
  });

  it("requests the provider-enforced wiki-node read permission", () => {
    expect(action("get_wiki_node").requiredScopes).toEqual(["wiki:node:read"]);
    expect(action("get_wiki_node").providerPermissions).toEqual(["wiki:node:read"]);
  });
});
