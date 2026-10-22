import { INPUT_BAR_COMPACT_SURFACE_CLASSES } from "@app/components/assistant/conversation/input_bar/inputBarCompactStyles";
import type { SidebarNavigation } from "@app/components/navigation/config";
import { NavigationSidebar } from "@app/components/navigation/NavigationSidebar";
import { useFloatingSidebarHover } from "@app/components/navigation/useFloatingSidebarHover";
import { SidebarContext } from "@app/components/sparkle/SidebarContext";
import { useUser } from "@app/lib/swr/user";
import type { SubscriptionType } from "@app/types/plan";
import type { WorkspaceType } from "@app/types/user";
import {
  Button,
  cn,
  Menu01,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import type React from "react";
import { forwardRef, useContext } from "react";

const MOBILE_NAV_MENU_BUTTON_CLASSES = cn(
  INPUT_BAR_COMPACT_SURFACE_CLASSES,
  "transition-none",
  "hover:border-transparent hover:bg-hover hover:backdrop-blur-none",
  "active:border-transparent active:bg-primary-300 active:backdrop-blur-none"
);

interface NavigationProps {
  hideSidebar: boolean;
  owner: WorkspaceType;
  subscription: SubscriptionType;
  navChildren?: React.ReactNode;
  subNavigation?: SidebarNavigation[] | null;
  isNavigationBarOpen: boolean;
  showOnEdgeHover: boolean;
  isMobile: boolean;
}

export function Navigation({
  hideSidebar,
  owner,
  subscription,
  navChildren,
  subNavigation,
  isNavigationBarOpen,
  showOnEdgeHover,
  isMobile,
}: NavigationProps) {
  const { user } = useUser();

  if (hideSidebar) {
    return null;
  }

  const sidebar = (
    <NavigationSidebar
      owner={owner}
      subscription={subscription}
      subNavigation={subNavigation}
      user={user}
      isMobile={isMobile}
    >
      {navChildren}
    </NavigationSidebar>
  );

  return (
    <div
      className={cn(
        "flex shrink-0 overflow-x-hidden",
        "text-primary",
        "bg-app-background"
      )}
    >
      {isMobile ? (
        <MobileNavigation>{sidebar}</MobileNavigation>
      ) : (
        <DesktopNavigation
          isNavigationBarOpen={isNavigationBarOpen}
          showOnEdgeHover={showOnEdgeHover}
        >
          {sidebar}
        </DesktopNavigation>
      )}
    </div>
  );
}

function MobileNavigation({ children }: { children: React.ReactNode }) {
  const { t } = useLingui();
  const { sidebarOpen, setSidebarOpen } = useContext(SidebarContext);

  return (
    <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
      <div className="fixed left-0 top-[var(--banner-height)] z-40 flex shrink-0 items-center px-2 pt-2">
        <SheetTrigger asChild>
          <Button
            variant="ghost"
            icon={Menu01}
            className={MOBILE_NAV_MENU_BUTTON_CLASSES}
            onClick={() => setSidebarOpen(true)}
            aria-label={t`Open navigation`}
          />
        </SheetTrigger>
      </div>
      <SheetContent
        side="left"
        className="flex w-full max-w-xs flex-1 bg-app-background"
      >
        <SheetHeader className="bg-app-background p-0" hideButton={true}>
          <VisuallyHidden>
            <SheetTitle className="hidden" />
          </VisuallyHidden>
        </SheetHeader>
        {children}
      </SheetContent>
    </Sheet>
  );
}

// Invisible areas compared with the cursor position by useFloatingSidebarHover.
// Each child is one area of the zone.

// Hovering opens the floating sidebar.
const FloatingSidebarRevealZone = forwardRef<HTMLDivElement>(
  function FloatingSidebarRevealZone(_props, ref) {
    return (
      <div ref={ref} aria-hidden className="pointer-events-none">
        {/* Left window edge. */}
        <div className="fixed bottom-[var(--dev-bar-height)] left-0 top-[var(--banner-height)] w-6" />
        {/* Show-sidebar button. */}
        <div className="fixed left-4 top-[calc(var(--banner-height)+1rem)] h-8 w-9" />
      </div>
    );
  }
);

// Only keeps the floating sidebar open, so drifting off the show-sidebar
// button does not close it.
const FloatingSidebarKeepOpenZone = forwardRef<HTMLDivElement>(
  function FloatingSidebarKeepOpenZone(_props, ref) {
    return (
      <div ref={ref} aria-hidden className="pointer-events-none">
        {/* Around the show-sidebar button. */}
        <div className="fixed left-0 top-[var(--banner-height)] size-28" />
      </div>
    );
  }
);

interface DesktopNavigationProps {
  isNavigationBarOpen: boolean;
  showOnEdgeHover: boolean;
  children: React.ReactNode;
}

function DesktopNavigation({
  isNavigationBarOpen,
  showOnEdgeHover,
  children,
}: DesktopNavigationProps) {
  const isFloating = !isNavigationBarOpen && showOnEdgeHover;
  const { isVisible, sidebarRef, revealZoneRef, keepOpenZoneRef } =
    useFloatingSidebarHover(isFloating);

  return (
    // Width-only spacer that pushes the content panel: the sidebar itself is
    // always `fixed`, so docking morphs the floating card into place instead
    // of revealing a new one from the left.
    <div
      className={cn(
        "flex-none sidebar-motion-[width]",
        isNavigationBarOpen ? "w-sidebar" : "w-0"
      )}
    >
      {isFloating && (
        <>
          <FloatingSidebarRevealZone ref={revealZoneRef} />
          <FloatingSidebarKeepOpenZone ref={keepOpenZoneRef} />
        </>
      )}
      <div
        ref={sidebarRef}
        className={cn(
          "fixed z-50 flex w-sidebar flex-col overflow-hidden border bg-app-background",
          "sidebar-motion-[translate,visibility,top,bottom,left]",
          isNavigationBarOpen
            ? "bottom-[var(--dev-bar-height)] left-0 top-[var(--banner-height)] rounded-none border-transparent shadow-none"
            : cn(
                "bottom-[calc(var(--dev-bar-height)+1rem)] left-0 top-[calc(var(--banner-height)+3.2rem)] rounded-r-xl border-border-dark shadow-[4px_0_12px_-6px_rgb(0_0_0/0.08),0_8px_16px_-8px_rgb(0_0_0/0.08)]",
                !isVisible &&
                  "invisible pointer-events-none -translate-x-[calc(100%+1rem)]"
              )
        )}
      >
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col transition-opacity ease-out motion-reduce:transition-none",
            !isNavigationBarOpen && !isVisible
              ? "opacity-0 duration-100"
              : "duration-200"
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
