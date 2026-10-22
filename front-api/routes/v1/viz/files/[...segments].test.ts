import { generateVizAccessToken } from "@app/lib/api/viz/access_tokens";
import { readAllowlistedScopedVizFile } from "@app/lib/api/viz/authorized_file_access";
import { FileResource } from "@app/lib/resources/file_resource";
import { FileFactory } from "@app/tests/utils/FileFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { frameContentType } from "@app/types/files";
import type { ModelId } from "@app/types/shared/model_id";
import { Ok } from "@app/types/shared/result";
import { honoApp } from "@front-api/app";
import { PassThrough } from "stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Allowlist resolution has its own tests. Stub it so these tests focus on how the endpoint streams
// the file back.
vi.mock("@app/lib/api/viz/authorized_file_access", () => ({
  assertVizFileAuthorized: vi.fn().mockResolvedValue("authorized"),
  resolveAllowlistedCanonicalPath: vi
    .fn()
    .mockReturnValue("conversation/data.csv"),
  readAllowlistedScopedVizFile: vi.fn(),
}));

describe("GET /api/v1/viz/files/:scope/:rel", () => {
  let authorization: string;

  beforeEach(async () => {
    vi.clearAllMocks();

    const { workspace, authenticator } = await createResourceTest({
      role: "user",
    });

    const frameFile = await FileFactory.create(authenticator, null, {
      contentType: frameContentType,
      fileName: "frame.html",
      fileSize: 1000,
      status: "ready",
      useCase: "conversation",
      useCaseMetadata: { conversationId: "conversation-A" },
    });
    const fileToken = (await frameFile.getShareInfo())?.shareUrl
      .split("/")
      .at(-1);
    if (!fileToken) {
      throw new Error("No file token found");
    }

    authorization = `Bearer ${generateVizAccessToken({
      contentType: frameContentType,
      fileToken,
      workspaceId: workspace.sId,
      shareScope: "workspace",
    })}`;

    vi.spyOn(FileResource, "fetchByShareTokenWithContent").mockResolvedValue({
      file: frameFile,
      content: "<html></html>",
      shareScope: "workspace",
      shareableFileId: 1 as unknown as ModelId,
      workspace,
      authorizedFileAccess: {
        generatedByUserId: null,
        frameContentHash: "hash",
        refs: [],
      },
    });
  });

  function mockFileStream() {
    const stream = new PassThrough();
    vi.mocked(readAllowlistedScopedVizFile).mockResolvedValue(
      new Ok({ contentType: "text/csv", stream })
    );
    return stream;
  }

  function request() {
    return honoApp.request("/api/v1/viz/files/conversation/data.csv", {
      headers: { authorization },
    });
  }

  it("streams the allowlisted file", async () => {
    const stream = mockFileStream();
    stream.end("a,b\n1,2\n");

    const response = await request();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv");
    expect(await response.text()).toBe("a,b\n1,2\n");
  });

  it("waits for storage to connect before destroying the stream when the client disconnects", async () => {
    const stream = mockFileStream();

    const response = await request();
    await response.body?.cancel();

    // Destroying before storage pipes into the stream makes that late pipe throw an unhandled
    // ERR_STREAM_UNABLE_TO_PIPE.
    expect(stream.destroyed).toBe(false);

    new PassThrough().pipe(stream);
    expect(stream.destroyed).toBe(true);
  });
});
