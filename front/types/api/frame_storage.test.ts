import {
  getFrameBasePath,
  getFrameDatabaseReplicaBasePath,
  getFrameDatabaseReplicasBasePath,
  getFramePersistentFilesBasePath,
  getFramePublicationDescriptorPath,
  getFramePublicationFunctionsArchivePath,
  getFramePublicationSourceArchivePath,
  getFramePublicationUiBundlePath,
} from "@app/types/api/frame_storage";
import { describe, expect, it } from "vitest";

const IDS = {
  workspaceId: "w_123",
  frameId: "fil_456",
  publicationId: "b8c2b796-534a-4ad2-a5ad-071da692ca0b",
};

describe("Frames v2 GCS paths", () => {
  it("keeps publications under the Frame identity", () => {
    expect(getFrameBasePath(IDS)).toBe("w/w_123/frames/fil_456/");
    expect(getFramePublicationDescriptorPath(IDS)).toBe(
      "w/w_123/frames/fil_456/publications/b8c2b796-534a-4ad2-a5ad-071da692ca0b/publication.json"
    );
    expect(getFramePublicationUiBundlePath(IDS)).toBe(
      "w/w_123/frames/fil_456/publications/b8c2b796-534a-4ad2-a5ad-071da692ca0b/ui/bundle.js"
    );
    expect(getFramePublicationFunctionsArchivePath(IDS)).toBe(
      "w/w_123/frames/fil_456/publications/b8c2b796-534a-4ad2-a5ad-071da692ca0b/functions.tar"
    );
  });

  it("keeps SQLite replica state outside publications", () => {
    expect(getFrameDatabaseReplicasBasePath(IDS)).toBe(
      "w/w_123/frames/fil_456/state/databases/"
    );
    expect(
      getFrameDatabaseReplicaBasePath({
        workspaceId: IDS.workspaceId,
        frameId: IDS.frameId,
        databaseName: "task_store",
      })
    ).toBe("w/w_123/frames/fil_456/state/databases/task_store.db/");
  });

  it("keeps the persistent files folder beside the SQLite replicas", () => {
    expect(getFramePersistentFilesBasePath(IDS)).toBe(
      "w/w_123/frames/fil_456/state/files/"
    );
  });

  it("puts the source archive in the publication prefix", () => {
    const args = { workspaceId: "w1", frameId: "f1", publicationId: "p1" };

    expect(getFramePublicationSourceArchivePath(args)).toBe(
      "w/w1/frames/f1/publications/p1/source.tar"
    );
  });

  it("rejects path traversal and unsafe identity segments", () => {
    expect(() =>
      getFrameBasePath({ workspaceId: "../other", frameId: IDS.frameId })
    ).toThrow("Invalid workspaceId");
    expect(() =>
      getFramePublicationFunctionsArchivePath({
        ...IDS,
        publicationId: "../other",
      })
    ).toThrow("Invalid publicationId");
    expect(() =>
      getFrameDatabaseReplicaBasePath({
        workspaceId: IDS.workspaceId,
        frameId: IDS.frameId,
        databaseName: "../other",
      })
    ).toThrow("Invalid databaseName");
    expect(() =>
      getFramePersistentFilesBasePath({
        workspaceId: IDS.workspaceId,
        frameId: "../other",
      })
    ).toThrow("Invalid frameId");
  });
});
