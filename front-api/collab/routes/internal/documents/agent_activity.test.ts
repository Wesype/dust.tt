import { CollabAgentFactory } from "@app/tests/utils/CollabAgentFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { COLLAB_AGENT_ACTIVITY_PATH } from "@app/types/collab_internal";
import {
  openNotes,
  post,
  SECRET,
  useInternalSecret,
} from "@front-api/collab/routes/routes.test_utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("POST /internal/documents/agent_activity", () => {
  beforeEach(useInternalSecret);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows an agent's activity in a thread only to a document its user may open", async () => {
    const { server, hocuspocus, name, request } = await openNotes();
    const { authenticator: outsider } = await createResourceTest({});
    const document = hocuspocus.documents.get(name);
    if (!document) {
      throw new Error("The document is not open.");
    }
    const broadcast = vi.spyOn(document, "broadcastStateless");
    const agent = CollabAgentFactory.build({ commentId: "c1" });
    const showAs = (userId: string) =>
      post(
        COLLAB_AGENT_ACTIVITY_PATH,
        { ...request, userId, agent, activity: "thinking" },
        `Bearer ${SECRET}`,
        server
      );

    expect((await showAs(outsider.getNonNullableUser().sId)).status).toBe(403);
    expect(broadcast).not.toHaveBeenCalled();

    expect((await showAs(request.userId)).status).toBe(200);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(broadcast.mock.calls[0][0]))).toEqual({
      type: "agent_activity",
      agent,
      activity: "thinking",
    });
  });
});
