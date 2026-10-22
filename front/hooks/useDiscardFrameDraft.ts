import {
  useSendApiErrorNotification,
  useSendNotification,
} from "@app/hooks/useNotification";
import { clientFetch } from "@app/lib/egress/client";
import { getErrorFromResponse } from "@app/lib/swr/swr";
import type { LightWorkspaceType } from "@app/types/user";
import { useLingui } from "@lingui/react/macro";

export function useDiscardFrameDraft({
  owner,
  frameId,
}: {
  owner: LightWorkspaceType;
  frameId: string;
}) {
  const { t } = useLingui();
  const sendApiErrorNotification = useSendApiErrorNotification();
  const sendNotification = useSendNotification();

  /**
   * Throws away the draft and ends draft mode, restoring the live source. `draftPublicationId`
   * is the draft the user saw, or the live publication when nothing changed: the server refuses
   * if a draft the user has not seen is pending.
   */
  return async (draftPublicationId: string): Promise<boolean> => {
    const res = await clientFetch(
      `/api/w/${owner.sId}/frames/${encodeURIComponent(frameId)}/discard-draft`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftPublicationId }),
      }
    );

    if (!res.ok) {
      sendApiErrorNotification({
        title: t`Could not discard the draft`,
        error: await getErrorFromResponse(res),
      });
      return false;
    }

    sendNotification({
      type: "success",
      title: t`Draft discarded`,
      description: t`The Frame is back to its live version.`,
    });
    return true;
  };
}
