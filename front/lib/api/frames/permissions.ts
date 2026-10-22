import { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import { Authenticator } from "@app/lib/auth";
import type { FileResource } from "@app/lib/resources/file_resource";

/**
 * Whether the authenticated user can modify the source files backing a Frame v2.
 *
 * The file system owns this decision: conversation access and Pod write access are
 * resolved from the Frame's canonical scoped source path.
 */
export async function canWriteFrameV2Source(
  auth: Authenticator,
  frame: FileResource
): Promise<boolean> {
  const user = auth.user();
  const workspace = auth.getNonNullableWorkspace();
  if (!user || !frame.isFrameV2 || frame.workspaceId !== workspace.id) {
    return false;
  }

  const sourcePath = frame.toScopedPath(auth);
  if (!sourcePath) {
    return false;
  }

  const fileSystemResult = await DustFileSystem.fromScopedPath(
    auth,
    sourcePath
  );
  if (fileSystemResult.isErr()) {
    return false;
  }

  return fileSystemResult.value.checkWriteAccess(sourcePath).isOk();
}

/**
 * Whether the caller may publish Frame Apps (see `frame-app-create-capability`). Sandbox-token
 * groups are narrowed to the conversation's spaces, which can drop a grant held through another
 * group, so a sandbox caller with a user is resolved from the user's full workspace groups.
 */
export async function canCreateFrameApps(
  auth: Authenticator
): Promise<boolean> {
  if (auth.hasWorkspacePermission("create", "frame_app")) {
    return true;
  }

  const user = auth.user();
  if (!auth.isSandboxToken() || !user) {
    return false;
  }

  const authWithAllUserGroups = await Authenticator.fromUserIdAndWorkspaceId(
    user.sId,
    auth.getNonNullableWorkspace().sId
  );
  return authWithAllUserGroups.hasWorkspacePermission("create", "frame_app");
}
