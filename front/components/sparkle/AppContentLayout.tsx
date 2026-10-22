import { CommandPalette } from "@app/components/command_palette/CommandPalette";
import { DEV_MODE_ACTIVE } from "@app/components/dev/devModeConstants";
import { useDesktopNavigation } from "@app/components/navigation/DesktopNavigationContext";
import { Navigation } from "@app/components/navigation/Navigation";
import { SidebarToggleSlotProvider } from "@app/components/navigation/SidebarToggleSlotContext";
import { TopBanners } from "@app/components/navigation/TopBanners";
import { useAppLayout } from "@app/components/sparkle/AppLayoutContext";
import { AppLayoutTitle } from "@app/components/sparkle/AppLayoutTitle";
import { useAppKeyboardShortcuts } from "@app/hooks/useAppKeyboardShortcuts";
import { useDocumentScrollMode } from "@app/hooks/useDocumentScrollMode";
import { useDocumentTitle } from "@app/hooks/useDocumentTitle";
import { useHashParam } from "@app/hooks/useHashParams";
import { useKeyboardShortcutLabel } from "@app/hooks/useKeyboardShortcutLabel";
import { useAuth, useWorkspace } from "@app/lib/auth/AuthContext";
import { MOBILE_DOCUMENT_SCROLL_CLASSES } from "@app/lib/documentScrollLayoutClasses";
import { APP_KEYBOARD_SHORTCUTS } from "@app/lib/keyboard_shortcuts";
import { useIsMobile } from "@app/lib/swr/useIsMobile";
import { FULL_SCREEN_HASH_PARAM } from "@app/types/conversation_side_panel";
import { cn, Menu01, PillButton } from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type React from "react";
import { lazy, Suspense } from "react";

// Lazy-load the dev panel only when dev mode is active.
// The module is never fetched/parsed/executed when dev mode is off.
const DevFeatureFlagPanel = DEV_MODE_ACTIVE
  ? lazy(() =>
      // Dynamic import is necessary here: the dev panel must not be bundled
      // in the main chunk — it should only load when dev mode is active.
      import("@app/components/dev/DevFeatureFlagPanel").then((m) => ({
        default: m.DevFeatureFlagPanel,
      }))
    )
  : null;

interface AppContentLayoutProps {
  children: React.ReactNode;
}

interface AppContentInnerWrapperProps {
  isNavigationBarOpen: boolean;
  isMobile: boolean;
  hasSidebarToggleSlot: boolean;
  onShowSidebar: () => void;
  children: React.ReactNode;
}

function AppContentInnerWrapper({
  isNavigationBarOpen,
  isMobile,
  hasSidebarToggleSlot,
  onShowSidebar,
  children,
}: AppContentInnerWrapperProps) {
  const { t } = useLingui();
  const toggleSidebarShortcut = useKeyboardShortcutLabel(
    APP_KEYBOARD_SHORTCUTS.toggleNavigationBar
  );
  const shouldReduceMotion = useReducedMotion();

  if (isMobile) {
    return children;
  }

  return (
    <div
      className={cn(
        "relative my-2 mr-2 rounded-xl flex-1 bg-panel-background border border-border overflow-hidden h-panel",
        "sidebar-motion-[margin]",
        !isNavigationBarOpen && "ml-2"
      )}
      style={{
        boxShadow:
          "0 0 0 0.4px rgba(0, 0, 0, 0.02), 0 0 1px 1px rgba(0, 0, 0, 0.02)",
      }}
    >
      <AnimatePresence initial={false}>
        {hasSidebarToggleSlot && (
          <motion.div
            key="lock-sidebar"
            className="absolute left-2 top-2"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0 } }}
            transition={
              shouldReduceMotion
                ? { duration: 0 }
                : { duration: 0.2, ease: "easeOut" }
            }
          >
            <PillButton
              icon={Menu01}
              label={t`Lock sidebar open`}
              onClick={onShowSidebar}
              tooltipShortcut={toggleSidebarShortcut}
              tooltipSide="right"
            />
          </motion.div>
        )}
      </AnimatePresence>
      {children}
    </div>
  );
}

export function AppContentLayout({ children }: AppContentLayoutProps) {
  const owner = useWorkspace();
  const isMobile = useIsMobile();
  const { featureFlags, subscription, user } = useAuth();
  const {
    contentClassName,
    contentWidth,
    hasTitle = false,
    hideSidebar = false,
    navChildren,
    pageTitle,
    subNavigation,
    title,
  } = useAppLayout();
  const [fullScreenHash] = useHashParam(FULL_SCREEN_HASH_PARAM);

  const isFullScreen = fullScreenHash === "true";

  const hasTitleBar = !!title || hasTitle;
  useDocumentTitle(pageTitle || `Dust - ${owner.name}`);
  useAppKeyboardShortcuts(owner);
  const { isNavigationBarOpen, setNavigationBarPreference } =
    useDesktopNavigation();

  useDocumentScrollMode(isMobile);

  const hasSidebarToggleSlot =
    !isMobile && !hideSidebar && !isNavigationBarOpen && !isFullScreen;

  const isCenteredContent = contentWidth === "centered";
  const hasTitleBarOffsetHeight = hasTitleBar && !!title && isCenteredContent;

  return (
    <div
      className={cn(
        "flex flex-col",
        isMobile ? MOBILE_DOCUMENT_SCROLL_CLASSES.contentRoot : "h-dvh"
      )}
    >
      <TopBanners owner={owner} subscription={subscription} />
      <div
        className={cn(
          "flex flex-row",
          isMobile
            ? MOBILE_DOCUMENT_SCROLL_CLASSES.contentRow
            : "min-h-0 flex-1"
        )}
      >
        <Navigation
          hideSidebar={hideSidebar}
          isNavigationBarOpen={isNavigationBarOpen}
          showOnEdgeHover={hasSidebarToggleSlot}
          owner={owner}
          subscription={subscription}
          navChildren={navChildren}
          subNavigation={subNavigation}
          isMobile={isMobile}
        />
        <div
          className={cn(
            "relative flex w-full flex-1 flex-col text-foreground",
            isMobile
              ? MOBILE_DOCUMENT_SCROLL_CLASSES.contentMain
              : "h-full overflow-x-hidden bg-app-background"
          )}
        >
          <AppContentInnerWrapper
            isNavigationBarOpen={isNavigationBarOpen}
            isMobile={isMobile}
            hasSidebarToggleSlot={hasSidebarToggleSlot}
            onShowSidebar={() => setNavigationBarPreference(true)}
          >
            <SidebarToggleSlotProvider value={hasSidebarToggleSlot}>
              <div
                className={cn(
                  "flex flex-1 flex-col",
                  isMobile
                    ? MOBILE_DOCUMENT_SCROLL_CLASSES.contentArea
                    : cn(
                        "min-h-0 overflow-y-auto [scrollbar-gutter:stable]",
                        !hasTitleBar && "h-panel"
                      )
                )}
              >
                {/* Temporary measure to preserve title existence on smaller screens.
                 * Page has no title, prepend empty AppLayoutTitle. */}
                {!hasTitleBar ? <AppLayoutTitle /> : null}
                {hasTitleBar && contentWidth ? title : null}
                <div
                  className={
                    contentWidth
                      ? cn(
                          "flex w-full flex-col items-center pt-2",
                          isMobile
                            ? MOBILE_DOCUMENT_SCROLL_CLASSES.contentArea
                            : "overflow-y-auto [scrollbar-gutter:stable]",
                          hasTitleBarOffsetHeight && "h-[calc(100vh-3.5rem)]",
                          !hasTitleBarOffsetHeight &&
                            (hasTitleBar || !isMobile) &&
                            "h-full",
                          contentClassName
                        )
                      : "contents"
                  }
                >
                  <div
                    className={
                      contentWidth
                        ? cn(
                            "flex w-full grow flex-col px-4",
                            isCenteredContent && "max-w-4xl"
                          )
                        : "contents"
                    }
                  >
                    {children}
                  </div>
                </div>
              </div>
            </SidebarToggleSlotProvider>
          </AppContentInnerWrapper>
        </div>
        <CommandPalette key={owner.sId} owner={owner} user={user} />
      </div>
      {DevFeatureFlagPanel && (
        <Suspense fallback={null}>
          <DevFeatureFlagPanel serverFlags={featureFlags} />
        </Suspense>
      )}
    </div>
  );
}
