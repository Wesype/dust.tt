import type { DefaultRemoteMCPServerConfig } from "@app/lib/actions/mcp_internal_actions/remote_servers";
import { Authenticator } from "@app/lib/auth";
import {
  DefaultRemoteMCPServerInMemoryResource,
  isAvailableToWorkspace,
} from "@app/lib/resources/default_remote_mcp_server_in_memory_resource";
import { FeatureFlagResource } from "@app/lib/resources/feature_flag_resource";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import type { WorkspaceType } from "@app/types/user";
import { describe, expect, it } from "vitest";

function makeConfig(
  gates: Pick<
    DefaultRemoteMCPServerConfig,
    "featureFlag" | "creditBasedPlansOnly"
  >
): DefaultRemoteMCPServerConfig {
  return {
    id: 99999,
    name: "Test",
    description: "",
    url: "https://mcp.example.com/mcp",
    icon: "ActionGlobeAltIcon",
    authMethod: null,
    ...gates,
  };
}

describe("isAvailableToWorkspace", () => {
  it.each([
    { gates: {}, isCreditBased: false, hasFlag: false, available: true },
    {
      gates: { featureFlag: "figma_mcp" as const },
      isCreditBased: true,
      hasFlag: false,
      available: false,
    },
    {
      gates: { featureFlag: "figma_mcp" as const },
      isCreditBased: false,
      hasFlag: true,
      available: true,
    },
    {
      gates: { creditBasedPlansOnly: true },
      isCreditBased: true,
      hasFlag: false,
      available: true,
    },
    {
      gates: { creditBasedPlansOnly: true },
      isCreditBased: false,
      hasFlag: false,
      available: false,
    },
    {
      gates: { creditBasedPlansOnly: true, featureFlag: "figma_mcp" as const },
      isCreditBased: true,
      hasFlag: false,
      available: true,
    },
    {
      gates: { creditBasedPlansOnly: true, featureFlag: "figma_mcp" as const },
      isCreditBased: false,
      hasFlag: true,
      available: true,
    },
    {
      gates: { creditBasedPlansOnly: true, featureFlag: "figma_mcp" as const },
      isCreditBased: false,
      hasFlag: false,
      available: false,
    },
  ])(
    "gates $gates: credit-based $isCreditBased, flag $hasFlag -> $available",
    ({ gates, isCreditBased, hasFlag, available }) => {
      expect(
        isAvailableToWorkspace(makeConfig(gates), {
          featureFlags: hasFlag ? ["figma_mcp"] : [],
          isCreditBased,
        })
      ).toBe(available);
    }
  );
});

async function listAvailableNames(workspace: WorkspaceType): Promise<string[]> {
  const auth = await Authenticator.internalAdminForWorkspace(workspace.sId);
  const resources =
    await DefaultRemoteMCPServerInMemoryResource.listAvailableDefaultRemoteMCPServers(
      auth
    );
  return resources.map((resource) => resource.toJSON().name);
}

// Figma is gated to credit-based plans with `figma_mcp` as the override.
describe("DefaultRemoteMCPServerInMemoryResource.listAvailableDefaultRemoteMCPServers", () => {
  it("offers Figma to credit-priced workspaces and hides it from others", async () => {
    expect(
      await listAvailableNames(await WorkspaceFactory.creditPriced())
    ).toContain("Figma");
    expect(
      await listAvailableNames(await WorkspaceFactory.basic())
    ).not.toContain("Figma");
  });

  it("offers Figma to other plans with the figma_mcp flag", async () => {
    const workspace = await WorkspaceFactory.basic();
    await FeatureFlagResource.enable(workspace, "figma_mcp");

    expect(await listAvailableNames(workspace)).toContain("Figma");
  });
});
