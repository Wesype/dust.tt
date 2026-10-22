import { ConfirmContext } from "@app/components/Confirm";
import { useDiscardFrameDraft } from "@app/hooks/useDiscardFrameDraft";
import { useEnterFrameDraftMode } from "@app/hooks/useEnterFrameDraftMode";
import { useMakeFrameDraftLive } from "@app/hooks/useMakeFrameDraftLive";
import {
  TRACKING_ACTIONS,
  TRACKING_AREAS,
  trackEvent,
} from "@app/lib/tracking";
import type { LightWorkspaceType } from "@app/types/user";
import {
  Button,
  Check,
  DotsHorizontal,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  XCircle,
} from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import { useContext, useState } from "react";

interface FrameDraftControlsProps {
  /** Whether the "Activate draft mode" menu is offered while draft mode is off. */
  canEnterDraftMode: boolean;
  draftMode: boolean;
  /** The pending draft, or null when nothing changed since draft mode was turned on. */
  draftPublicationId: string | null;
  frameId: string;
  hideLabels: boolean;
  livePublicationId: string | null;
  /** Refreshes what the panel shows after a discard restored the live version. */
  onDraftDiscarded: () => Promise<unknown>;
  /** Refreshes the Frame's permissions after draft mode changed (or failed to). */
  onDraftModeChanged: () => Promise<unknown>;
  owner: LightWorkspaceType;
}

/**
 * Draft mode for a Frame's editors in the conversation panel: a "more" menu that turns it on,
 * then, while it is on, the action that ends it, making its changes live if there are any.
 */
export function FrameDraftControls({
  canEnterDraftMode,
  draftMode,
  draftPublicationId,
  frameId,
  hideLabels,
  livePublicationId,
  onDraftDiscarded,
  onDraftModeChanged,
  owner,
}: FrameDraftControlsProps) {
  const { t } = useLingui();
  const enterDraftMode = useEnterFrameDraftMode({ owner, frameId });
  const makeDraftLive = useMakeFrameDraftLive({ owner, frameId });
  const discardDraft = useDiscardFrameDraft({ owner, frameId });
  const confirm = useContext(ConfirmContext);
  const [pendingAction, setPendingAction] = useState<
    "enter" | "validate" | "discard" | null
  >(null);
  const isPending = pendingAction !== null;
  const hasChanges = draftPublicationId !== null;

  if (draftMode && livePublicationId) {
    const handleValidate = async () => {
      trackEvent({
        area: TRACKING_AREAS.FRAMES,
        object: "draft_make_live",
        action: TRACKING_ACTIONS.CLICK,
        extra: {
          frame_id: frameId,
          draft_publication_id: draftPublicationId ?? "",
          has_changes: hasChanges,
        },
      });
      setPendingAction("validate");
      try {
        // With nothing changed, naming the live publication only ends draft mode.
        await makeDraftLive(draftPublicationId ?? livePublicationId, {
          hasChanges,
        });
        // Refreshes either way: success ends draft mode; a conflict brings the newer draft in.
        await onDraftModeChanged();
      } finally {
        setPendingAction(null);
      }
    };

    const handleDiscard = async () => {
      trackEvent({
        area: TRACKING_AREAS.FRAMES,
        object: "draft_discard",
        action: TRACKING_ACTIONS.CLICK,
        extra: {
          frame_id: frameId,
          draft_publication_id: draftPublicationId ?? "",
          has_changes: hasChanges,
        },
      });
      const confirmed = await confirm({
        title: t`Discard this draft?`,
        message: t`Your changes since the live version will be lost. This can't be undone.`,
        validateLabel: t`Discard`,
        validateVariant: "warning",
      });
      if (!confirmed) {
        return;
      }
      setPendingAction("discard");
      try {
        // With nothing changed, naming the live publication refuses a draft pending since.
        if (await discardDraft(draftPublicationId ?? livePublicationId)) {
          await onDraftDiscarded();
        } else {
          // A conflict means the state moved, and the refresh shows it.
          await onDraftModeChanged();
        }
      } finally {
        setPendingAction(null);
      }
    };

    return (
      <>
        <Button
          label={hideLabels ? undefined : t`Discard draft`}
          icon={XCircle}
          size="xs"
          variant="outline"
          isLoading={pendingAction === "discard"}
          disabled={isPending}
          onClick={() => {
            void handleDiscard();
          }}
          aria-label={t`Discard draft`}
          tooltip={t`Go back to the live version and leave draft mode`}
        />
        <Button
          label={hideLabels ? undefined : t`Validate draft`}
          icon={Check}
          size="xs"
          variant="highlight"
          isLoading={pendingAction === "validate"}
          disabled={isPending}
          onClick={() => {
            void handleValidate();
          }}
          aria-label={t`Validate draft`}
          tooltip={
            hasChanges
              ? t`Show these changes on the share link`
              : t`No changes yet. This leaves draft mode.`
          }
        />
      </>
    );
  }

  if (!canEnterDraftMode) {
    return null;
  }

  const handleEnterDraftMode = async () => {
    trackEvent({
      area: TRACKING_AREAS.FRAMES,
      object: "draft_mode_enter",
      action: TRACKING_ACTIONS.CLICK,
      extra: { frame_id: frameId },
    });
    setPendingAction("enter");
    try {
      if (await enterDraftMode()) {
        await onDraftModeChanged();
      }
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          icon={DotsHorizontal}
          variant="ghost"
          isLoading={pendingAction === "enter"}
          aria-label={t`More actions`}
          tooltip={t`More actions`}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem
          label={t`Activate draft mode`}
          disabled={isPending}
          onClick={() => {
            void handleEnterDraftMode();
          }}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
