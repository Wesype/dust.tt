import { isToolAuthorized } from "@app/lib/api/frames/tool_authorization_coverage";
import type { Authenticator } from "@app/lib/auth";
import type { FileResource } from "@app/lib/resources/file_resource";
import { FramePublicationResource } from "@app/lib/resources/frame_publication_resource";
import { FrameToolAuthorizationResource } from "@app/lib/resources/frame_tool_authorization_resource";
import { UserResource } from "@app/lib/resources/user_resource";
import { getFrameV2NameFromManifestPath } from "@app/types/api/frame_manifest";
import type { FrameToolCallPair } from "@app/types/api/frame_publication";

export { isToolAuthorized } from "@app/lib/api/frames/tool_authorization_coverage";

/**
 * Whether the caller is the last publisher of the Frame's active publication
 * (exempt from Frame-scoped tool consent).
 */
export async function isFrameLastPublisher(
  auth: Authenticator,
  frame: FileResource
): Promise<boolean> {
  if (!frame.isFrameV2 || !frame.useCaseMetadata?.activePublicationId) {
    return false;
  }

  const user = auth.user();
  if (!user) {
    return false;
  }

  const activePublication =
    await FramePublicationResource.fetchForFramePublication(
      auth,
      frame,
      frame.useCaseMetadata.activePublicationId
    );

  return (
    activePublication?.publishedByUserId !== null &&
    activePublication?.publishedByUserId === user.id
  );
}

/**
 * Whether the caller has already Always-allowed this tool for this Frame.
 * Pairs must use `[mcpServerView.sId, toolName]`.
 */
export async function hasAuthorizedFrameTool(
  auth: Authenticator,
  {
    frame,
    tool,
  }: {
    frame: FileResource;
    tool: FrameToolCallPair;
  }
): Promise<boolean> {
  if (!frame.isFrameV2) {
    return true;
  }

  const authorization =
    await FrameToolAuthorizationResource.fetchForUserAndFrame(auth, frame);
  if (!authorization) {
    return false;
  }

  return isToolAuthorized(authorization.authorizedTools, tool);
}

/**
 * Display name + last publisher for Frame tool-approval copy.
 */
export async function getFrameToolApprovalSubject(
  auth: Authenticator,
  frame: FileResource
): Promise<{ frameName: string; publisherName: string | null }> {
  const packageRoot = frame.getFrameV2SourceDirectoryPath(auth);
  const frameName =
    (frame.mountFilePath
      ? getFrameV2NameFromManifestPath(frame.mountFilePath)
      : null) ??
    packageRoot?.split("/").pop() ??
    frame.sId;

  const publicationId = frame.useCaseMetadata?.activePublicationId;
  if (!publicationId) {
    return { frameName, publisherName: null };
  }

  const publication = await FramePublicationResource.fetchForFramePublication(
    auth,
    frame,
    publicationId
  );
  if (!publication?.publishedByUserId) {
    return { frameName, publisherName: null };
  }

  const [publisher] = await UserResource.fetchByModelIds([
    publication.publishedByUserId,
  ]);
  return {
    frameName,
    publisherName: publisher?.fullName() || null,
  };
}
