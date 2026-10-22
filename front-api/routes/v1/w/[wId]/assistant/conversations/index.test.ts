import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createPublicApiMockRequest } from "@app/tests/utils/generic_public_api_tests";
import { honoApp } from "@front-api/app";
import { describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/programmatic_usage/tracking", () => ({
  isProgrammaticUsage: () => false,
  checkProgrammaticUsageLimits: vi.fn(),
}));

function postConversations(
  workspace: { sId: string },
  key: { secret: string },
  body: unknown
) {
  return honoApp.request(`/api/v1/w/${workspace.sId}/assistant/conversations`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key.secret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/v1/w/[wId]/assistant/conversations", () => {
  it("returns 401 when an API key (no user) sends selectedMCPServerViewIds", async () => {
    const { workspace, key } = await createPublicApiMockRequest();

    const response = await postConversations(workspace, key, {
      title: "Test conversation",
      message: {
        content: "Hello",
        mentions: [],
        context: {
          username: "tester",
          timezone: "Europe/Paris",
          origin: "api",
          selectedMCPServerViewIds: ["msv_abcdef123456"],
        },
      },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        type: "invalid_request_error",
        message:
          "Selecting MCP server views is only available to authenticated users.",
      },
    });
  });

  it("returns 401 when an API key (no user) sends clientSideMCPServerIds", async () => {
    const { workspace, key } = await createPublicApiMockRequest();

    const response = await postConversations(workspace, key, {
      title: "Test conversation",
      message: {
        content: "Hello",
        mentions: [],
        context: {
          username: "tester",
          timezone: "Europe/Paris",
          origin: "api",
          clientSideMCPServerIds: ["mcp_local_abc"],
        },
      },
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: {
        type: "invalid_request_error",
        message: "Local MCP servers are only available to authenticated users.",
      },
    });
  });

  it("returns 400 when the request body fails schema validation", async () => {
    const { workspace, key } = await createPublicApiMockRequest();

    const response = await postConversations(workspace, key, {
      message: { content: "missing mentions and context" },
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.type).toBe("invalid_request_error");
  });

  it("returns 400 when depth is negative", async () => {
    const { workspace, key } = await createPublicApiMockRequest();

    const response = await postConversations(workspace, key, {
      title: "Test conversation",
      depth: -2000000000,
      message: {
        content: "Hello",
        mentions: [],
        context: {
          username: "tester",
          timezone: "Europe/Paris",
          origin: "api",
        },
      },
    });

    expect(response.status).toBe(400);
    expect((await response.json()).error.type).toBe("invalid_request_error");
  });

  describe("parentConversationId", () => {
    it("returns 403 when a regular key sets it", async () => {
      const { auth, workspace, key } = await createPublicApiMockRequest({
        method: "POST",
      });
      const parent = await ConversationFactory.create(auth, {
        agentConfigurationId: "dust",
        messagesCreatedAt: [],
      });

      const response = await postConversations(workspace, key, {
        title: "Sub-conversation",
        depth: 1,
        parentConversationId: parent.sId,
      });

      expect(response.status).toBe(403);
      expect((await response.json()).error.type).toBe("workspace_auth_error");
    });

    it("returns 404 when the parent conversation does not exist", async () => {
      const { workspace, key } = await createPublicApiMockRequest({
        method: "POST",
        systemKey: true,
      });

      const response = await postConversations(workspace, key, {
        title: "Sub-conversation",
        depth: 1,
        parentConversationId: "conv_does_not_exist",
      });

      expect(response.status).toBe(404);
      expect((await response.json()).error.type).toBe("conversation_not_found");
    });

    it("returns 400 when depth is not the parent's depth plus one", async () => {
      const { auth, workspace, key } = await createPublicApiMockRequest({
        method: "POST",
        systemKey: true,
      });
      const parent = await ConversationFactory.create(auth, {
        agentConfigurationId: "dust",
        messagesCreatedAt: [],
      });

      const response = await postConversations(workspace, key, {
        title: "Sub-conversation",
        depth: 2,
        parentConversationId: parent.sId,
      });

      expect(response.status).toBe(400);
      expect((await response.json()).error.type).toBe("invalid_request_error");
    });

    it("stores the parent conversation", async () => {
      const { auth, workspace, key } = await createPublicApiMockRequest({
        method: "POST",
        systemKey: true,
      });
      const parent = await ConversationFactory.create(auth, {
        agentConfigurationId: "dust",
        messagesCreatedAt: [],
      });

      const response = await postConversations(workspace, key, {
        title: "Sub-conversation",
        depth: 1,
        parentConversationId: parent.sId,
      });

      expect(response.status).toBe(200);
      const { conversation } = await response.json();
      const created = await ConversationResource.fetchById(
        auth,
        conversation.sId
      );
      expect(created?.parentConversationId).toBe(parent.id);
    });
  });
});
