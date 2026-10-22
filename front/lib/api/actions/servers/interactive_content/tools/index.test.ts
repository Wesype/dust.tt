import {
  CREATE_INTERACTIVE_CONTENT_FILE_TOOL_NAME,
  EXPORT_INTERACTIVE_CONTENT_FILE_TOOL_NAME,
} from "@app/lib/api/actions/servers/interactive_content/metadata";
import { createInteractiveContentTools } from "@app/lib/api/actions/servers/interactive_content/tools";
import {
  makeExtra,
  setupPlainConversation,
} from "@app/tests/utils/conversation_test_factories";
import { frameContentType } from "@app/types/files";
import { Err, Ok } from "@app/types/shared/result";
import { describe, expect, it, vi } from "vitest";

const { fetchTemplateContent, createClientExecutableFile } = vi.hoisted(() => ({
  fetchTemplateContent: vi.fn(),
  createClientExecutableFile: vi.fn(),
}));

vi.mock(
  "@app/lib/api/actions/servers/interactive_content/template_utils",
  () => ({ fetchTemplateContent })
);
vi.mock("@app/lib/api/files/client_executable", () => ({
  createClientExecutableFile,
}));

describe("createInteractiveContentTools", () => {
  it("serves only template creation and export", async () => {
    const { auth, conversation } = await setupPlainConversation();
    const extra = makeExtra(auth, conversation);

    const tools = await createInteractiveContentTools(auth, {
      runContext: extra.runContext,
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      CREATE_INTERACTIVE_CONTENT_FILE_TOOL_NAME,
      EXPORT_INTERACTIVE_CONTENT_FILE_TOOL_NAME,
    ]);
    const createTool = tools[0];
    expect(Object.keys(createTool.schema)).not.toContain("mode");
  });

  it("creates the Frame from the referenced template's content", async () => {
    fetchTemplateContent.mockResolvedValue(new Ok("template source"));
    createClientExecutableFile.mockResolvedValue(
      new Err({ message: "stop", tracked: false })
    );
    const { auth, conversation } = await setupPlainConversation();
    const extra = makeExtra(auth, conversation);
    const [createTool] = await createInteractiveContentTools(auth, {
      runContext: extra.runContext,
    });

    await createTool.handler(
      {
        file_name: "Proposal.tsx",
        mime_type: frameContentType,
        source: "proposal_template_node",
      },
      extra
    );

    expect(fetchTemplateContent).toHaveBeenCalledWith(auth, extra.runContext, {
      templateRef: "proposal_template_node",
    });
    expect(createClientExecutableFile).toHaveBeenCalledWith(
      auth,
      expect.objectContaining({
        content: "template source",
        conversationId: conversation.sId,
        fileName: "Proposal.tsx",
      })
    );
  });
});
