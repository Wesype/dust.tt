import { useHasSidebarToggleSlot } from "@app/components/navigation/SidebarToggleSlotContext";
import { SpaceBreadCrumbs } from "@app/components/spaces/SpaceBreadcrumb";
import { LinkWrapper } from "@app/lib/platform";
import type { DataSourceViewCategory } from "@app/types/api/public/spaces";
import type { DataSourceViewType } from "@app/types/data_source_view";
import type { EnrichedSpaceType } from "@app/types/space";
import type { LightWorkspaceType } from "@app/types/user";
import { cn } from "@dust-tt/sparkle";
import { Trans } from "@lingui/react/macro";
import React from "react";

export const ACTION_BUTTONS_CONTAINER_ID = "space-action-buttons-container";
export const TRIGGER_BUTTONS_CONTAINER_ID = "space-trigger-buttons-container";

interface SpacePageTitleProps {
  category: DataSourceViewCategory | undefined;
  dataSourceView: DataSourceViewType | undefined;
  owner: LightWorkspaceType;
  parentId: string | undefined;
  space: EnrichedSpaceType;
}

export function SpacePageTitle({
  category,
  dataSourceView,
  owner,
  parentId,
  space,
}: SpacePageTitleProps) {
  const hasSidebarToggleSlot = useHasSidebarToggleSlot();

  return (
    <div
      className={cn(
        "flex min-h-pill-button w-full flex-wrap items-center justify-between gap-2 px-4",
        hasSidebarToggleSlot && "pl-sidebar-toggle-slot"
      )}
    >
      <div className="-my-0.5">
        <SpaceBreadCrumbs
          space={space}
          category={category}
          owner={owner}
          dataSourceView={dataSourceView}
          parentId={parentId}
        />
      </div>
    </div>
  );
}

// Portal targets for page-level action buttons, rendered next to the search input.
export function SpacePageActionButtons() {
  return (
    <>
      <div
        id={ACTION_BUTTONS_CONTAINER_ID}
        className="flex flex-wrap gap-2 empty:hidden"
      />
      <div
        id={TRIGGER_BUTTONS_CONTAINER_ID}
        className="flex gap-2 empty:hidden"
      />
    </>
  );
}

interface SpacePageDescriptionProps {
  category: DataSourceViewCategory | undefined;
  dataSourceView: DataSourceViewType | undefined;
  space: EnrichedSpaceType;
}

export function SpacePageDescription({
  category,
  dataSourceView,
  space,
}: SpacePageDescriptionProps) {
  const description = React.useMemo(() => {
    if (space.kind === "system") {
      if (category === "managed" && !dataSourceView) {
        return (
          <>
            <Trans>
              Here you can authorize Connections and control what data Dust can
              access. Once connected, data can be distributed to Open Spaces
              (accessible to all workspace members) or Restricted Spaces
              (limited access).
            </Trans>{" "}
            <br />
            <Trans>
              Need help? Check out our{" "}
              <LinkWrapper
                href="https://docs.dust.tt/docs/data"
                className="text-highlight"
                target="_blank"
              >
                guide
              </LinkWrapper>
              .
            </Trans>
          </>
        );
      } else if (category === "triggers") {
        return (
          <Trans>
            Here you can add new trigger sources to your workspace. Once
            created, those sources can be used in the Agent Builder to trigger
            agents.
          </Trans>
        );
      } else {
        return null;
      }
    }

    return null;
  }, [category, dataSourceView, space.kind]);

  if (!description) {
    return null;
  }

  return <div className="text-sm text-muted-foreground">{description}</div>;
}
