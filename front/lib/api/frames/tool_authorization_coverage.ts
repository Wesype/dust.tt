import type { FrameToolCallPair } from "@app/types/api/frame_publication";

/**
 * Whether the given tool pair appears in the user's Frame authorization set.
 */
export function isToolAuthorized(
  authorizedTools: FrameToolCallPair[],
  pair: FrameToolCallPair
): boolean {
  return authorizedTools.some(
    ([server, tool]) => server === pair[0] && tool === pair[1]
  );
}
