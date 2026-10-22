import { MCPError } from "@app/lib/actions/mcp_errors";
import type { MCPProgressNotificationType } from "@app/lib/actions/mcp_internal_actions/output_schemas";
import type {
  ToolDefinition,
  ToolHandlers,
} from "@app/lib/actions/mcp_internal_actions/tool_definition";
import { buildTools } from "@app/lib/actions/mcp_internal_actions/tool_definition";
import type { ToolContext } from "@app/lib/actions/types";
import { isAgentLoopRunContext } from "@app/lib/actions/types";
import { buildInteractiveContentFileNotification } from "@app/lib/api/actions/servers/interactive_content/helpers";
import { INTERACTIVE_CONTENT_TOOLS_METADATA } from "@app/lib/api/actions/servers/interactive_content/metadata";
import { fetchTemplateContent } from "@app/lib/api/actions/servers/interactive_content/template_utils";
import { createClientExecutableFile } from "@app/lib/api/files/client_executable";
import { formatValidationWarningsForLLM } from "@app/lib/api/files/content_validation";
import { exportInteractiveContentFileAsPdf } from "@app/lib/api/files/pdf_export";
import { screenshotInteractiveContentFile } from "@app/lib/api/files/screenshot";
import type { Authenticator } from "@app/lib/auth";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { INTERNAL_MIME_TYPES } from "@dust-tt/client";
import assert from "assert";

/**
 * @cc [owner:flvndvd,label:product] frames-v2-tool-allowlist
 * This server MUST expose only Frame creation from a template and Frame export. Inline Frame
 * creation, editing, and publishing MUST remain unavailable through this MCP server.
 */
export async function createInteractiveContentTools(
  auth: Authenticator,
  toolContext?: ToolContext
): Promise<ToolDefinition[]> {
  const handlers: ToolHandlers<typeof INTERACTIVE_CONTENT_TOOLS_METADATA> = {
    create_interactive_content_file: async (
      { file_name, mime_type, source, description },
      { sendNotification, _meta }
    ) => {
      // TODO: enable create and publish to be conversation agnostic for both templates (local) and
      //       createClientExecutablefile direclty on pod DFS so that we can re-enable this server
      //       when run without conversation context.
      assert(
        isAgentLoopRunContext(toolContext?.runContext),
        "AgentLoopRunContext expected"
      );

      const { conversation, agentConfiguration } = toolContext.runContext;

      const templateResult = await fetchTemplateContent(
        auth,
        toolContext.runContext,
        { templateRef: source }
      );
      if (templateResult.isErr()) {
        return templateResult;
      }

      const result = await createClientExecutableFile(auth, {
        content: templateResult.value,
        conversationId: conversation.sId,
        fileName: file_name,
        mimeType: mime_type,
        createdByAgentConfigurationId: agentConfiguration?.sId,
      });

      if (result.isErr()) {
        return new Err(
          new MCPError(result.error.message, {
            tracked: result.error.tracked,
          })
        );
      }

      const { fileResource, warnings } = result.value;

      let responseText = description
        ? `File '${fileResource.sId}' created successfully. ${description}`
        : `File '${fileResource.sId}' created successfully.`;

      responseText += formatValidationWarningsForLLM(warnings);

      if (_meta?.progressToken) {
        const notification: MCPProgressNotificationType =
          buildInteractiveContentFileNotification(
            _meta.progressToken,
            fileResource,
            "Creating interactive file..."
          );

        // Send a notification to the MCP Client, to display the interactive file.
        await sendNotification(notification);
      }

      return new Ok([
        {
          type: "resource",
          resource: {
            contentType: fileResource.contentType,
            fileId: fileResource.sId,
            mimeType: INTERNAL_MIME_TYPES.TOOL_OUTPUT.FILE,
            snippet: fileResource.snippet,
            text: responseText,
            title: fileResource.fileName,
            uri: fileResource.getPublicUrl(auth),
          },
        },
      ]);
    },

    export_interactive_content_file: async ({
      file_id,
      format,
      orientation,
    }) => {
      switch (format) {
        case "pdf": {
          const result = await exportInteractiveContentFileAsPdf(auth, {
            fileId: file_id,
            orientation,
          });
          if (result.isErr()) {
            return new Err(
              new MCPError(result.error.message, { tracked: false })
            );
          }
          return new Ok([
            {
              type: "resource",
              resource: {
                uri: result.value.fileName,
                mimeType: "application/pdf",
                blob: result.value.buffer.toString("base64"),
              },
            },
          ]);
        }
        case "png": {
          const result = await screenshotInteractiveContentFile(auth, {
            fileId: file_id,
          });
          if (result.isErr()) {
            return new Err(
              new MCPError(result.error.message, { tracked: false })
            );
          }
          return new Ok([
            {
              type: "image",
              data: result.value.buffer.toString("base64"),
              mimeType: "image/png",
            },
          ]);
        }
        default:
          assertNever(format);
      }
    },
  };

  return buildTools(INTERACTIVE_CONTENT_TOOLS_METADATA, handlers);
}
