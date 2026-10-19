import {
  buildAuditLogTarget,
  emitAuditLogEvent,
  getAuditLogContext,
} from "@app/lib/api/audit/workos_audit";
import type { Authenticator } from "@app/lib/auth";
import { DustError } from "@app/lib/error";
import type { FileResource } from "@app/lib/resources/file_resource";
import { FramePublicationResource } from "@app/lib/resources/frame_publication_resource";
import { FrameToolAuthorizationResource } from "@app/lib/resources/frame_tool_authorization_resource";
import { getFrameV2NameFromManifestPath } from "@app/types/api/frame_manifest";
import type { FrameToolCallPair } from "@app/types/api/frame_publication";
import { Err, Ok } from "@app/types/shared/result";
import type { Result } from "@app/types/shared/result";

function pairKey([server, tool]: FrameToolCallPair): string {
  return `${server}\0${tool}`;
}

/**
 * Whether every required tool pair appears in the authorized set.
 * Empty `requiredTools` is always satisfied (nothing to consent to).
 */
export function authorizedToolsCoverRequired(
  authorizedTools: FrameToolCallPair[],
  requiredTools: FrameToolCallPair[]
): boolean {
  if (requiredTools.length === 0) {
    return true;
  }
  const authorized = new Set(authorizedTools.map(pairKey));
  return requiredTools.every((pair) => authorized.has(pairKey(pair)));
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
