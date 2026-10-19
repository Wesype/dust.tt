import {
  buildAuditLogTarget,
  emitAuditLogEvent,
  getAuditLogContext,
} from "@app/lib/api/audit/workos_audit";
import { authorizedToolsCoverRequired } from "@app/lib/api/frames/tool_authorization_coverage";
import type { Authenticator } from "@app/lib/auth";
import { DustError } from "@app/lib/error";
import type { FileResource } from "@app/lib/resources/file_resource";
import { FramePublicationResource } from "@app/lib/resources/frame_publication_resource";
import { FrameToolAuthorizationResource } from "@app/lib/resources/frame_tool_authorization_resource";
import { getFrameV2NameFromManifestPath } from "@app/types/api/frame_manifest";
import type { FrameToolCallPair } from "@app/types/api/frame_publication";
import { Err, Ok } from "@app/types/shared/result";
import type { Result } from "@app/types/shared/result";

export { authorizedToolsCoverRequired } from "@app/lib/api/frames/tool_authorization_coverage";

/**
 * Whether the current user may run Frame functions that call tools.
 * Last publisher of the active publication is exempt; otherwise a stored
 * authorization must cover that publication's `requiredTools`.
 */
export async function hasAuthorizedFrameRequiredTools(
  auth: Authenticator,
  frame: FileResource
): Promise<boolean> {
  if (!frame.isFrameV2) {
    return true;
  }

  if (!frame.useCaseMetadata?.activePublicationId) {
    return false;
  }

  const activePublication =
    await FramePublicationResource.fetchForFramePublication(
      auth,
      frame,
      frame.useCaseMetadata.activePublicationId
    );
  const requiredTools = activePublication?.requiredTools ?? [];
  if (requiredTools.length === 0) {
    return true;
  }

  const user = auth.user();
  if (
    user &&
    activePublication?.publishedByUserId !== null &&
    activePublication?.publishedByUserId === user.id
  ) {
    return true;
  }

  const authorization =
    await FrameToolAuthorizationResource.fetchForUserAndFrame(auth, frame);
  return authorization
    ? authorizedToolsCoverRequired(authorization.authorizedTools, requiredTools)
    : false;
}

export async function updateAuthorizedTools(
  auth: Authenticator,
  {
    frame,
    authorizedTools,
  }: { frame: FileResource; authorizedTools: FrameToolCallPair[] }
): Promise<
  Result<
    FrameToolAuthorizationResource,
    DustError<"file_not_found" | "invalid_request_error">
  >
> {
  if (!frame?.isFrameV2) {
    return new Err(new DustError("file_not_found", "Frame not found."));
  }

  if (!frame.useCaseMetadata?.activePublicationId) {
    return new Err(
      new DustError(
        "invalid_request_error",
        "This Frame has no active publication."
      )
    );
  }

  const activePublication =
    await FramePublicationResource.fetchForFramePublication(
      auth,
      frame,
      frame.useCaseMetadata.activePublicationId
    );
  if (!activePublication) {
    return new Err(
      new DustError(
        "invalid_request_error",
        "This Frame has no active publication."
      )
    );
  }

  const required = [...activePublication.requiredTools]
    .map(([server, tool]) => `${server}\0${tool}`)
    .sort()
    .join("|");
  const submitted = [...authorizedTools]
    .map(([server, tool]) => `${server}\0${tool}`)
    .sort()
    .join("|");
  if (required !== submitted) {
    return new Err(
      new DustError(
        "invalid_request_error",
        "authorizedTools must match the active publication's requiredTools."
      )
    );
  }

  const authorization =
    await FrameToolAuthorizationResource.upsertForUserAndFrame(auth, {
      frame,
      authorizedTools: activePublication.requiredTools,
    });

  void emitAuditLogEvent({
    auth,
    action: "frame.tool_authorization_updated",
    targets: [
      buildAuditLogTarget("workspace", auth.getNonNullableWorkspace()),
      buildAuditLogTarget("frame", {
        sId: frame.sId,
        name:
          (frame.mountFilePath
            ? getFrameV2NameFromManifestPath(frame.mountFilePath)
            : null) ?? frame.sId,
      }),
    ],
    context: getAuditLogContext(auth),
    metadata: {
      frame_id: frame.sId,
      authorized_tool_count: String(authorization.authorizedTools.length),
      authorized_tools: authorization.authorizedTools
        .map(([server, tool]) => `${server}.${tool}`)
        .join(", "),
    },
  });

  return new Ok(authorization);
}
