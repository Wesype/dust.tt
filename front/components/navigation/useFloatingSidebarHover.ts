import { useEffect, useRef, useState } from "react";

const HOVER_CLOSE_DELAY_MS = 200;

// A menu or popover opened from the sidebar (e.g. the user menu).
const OPEN_POPUP_SELECTOR = '[aria-haspopup][aria-expanded="true"]';

function isPointInside(element: Element | null, x: number, y: number) {
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

// The sidebar's menus render in portals, outside of it.
function hasOpenPopup(sidebar: Element | null) {
  return !!sidebar?.querySelector(OPEN_POPUP_SELECTOR);
}

// Radix modal layers (dialogs, modal menus) disable pointer events on the
// body while open.
function isModalLayerOpen() {
  return document.body.style.pointerEvents === "none";
}

// Zone areas are `pointer-events-none` so they never swallow clicks, selection
// or scrolling on the content they overlap: compare the cursor position with
// their bounds instead.
function isPointInsideZones(zones: (Element | null)[], x: number, y: number) {
  return zones.some((zone) =>
    Array.from(zone?.children ?? []).some((area) => isPointInside(area, x, y))
  );
}

function isPointerOver(
  event: PointerEvent,
  sidebar: Element | null,
  zones: (Element | null)[]
) {
  return (
    isPointInsideZones(zones, event.clientX, event.clientY) ||
    // Only true while the sidebar is shown: once hidden, it is
    // `pointer-events-none` and never the event target.
    (event.target instanceof Node && !!sidebar?.contains(event.target))
  );
}

function shouldFloatingSidebarBeOpen(
  event: PointerEvent,
  sidebar: Element | null,
  zones: (Element | null)[]
) {
  if (hasOpenPopup(sidebar)) {
    return true;
  }
  // Behind a modal layer the sidebar would be unreachable: do not reveal it.
  return !isModalLayerOpen() && isPointerOver(event, sidebar, zones);
}

/**
 * Hover-to-reveal for the hidden desktop sidebar. Hovering the reveal zone
 * opens it; leaving the reveal zone, the keep-open zone (extra areas that only
 * keep it open) and the sidebar closes it.
 * Zone refs go on elements whose children are the zone's areas.
 */
export function useFloatingSidebarHover(isFloating: boolean) {
  const [isHoverOpen, setIsHoverOpen] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const revealZoneRef = useRef<HTMLDivElement>(null);
  const keepOpenZoneRef = useRef<HTMLDivElement>(null);

  // Every pointer move decides whether the sidebar should be open: it opens
  // right away, and a timer debounces closing. Pointer moves keep reaching the
  // document while a modal menu or dialog disables pointer events on the page,
  // unlike mouseenter/leave.
  useEffect(() => {
    if (!isFloating) {
      return;
    }

    let isOpen = false;
    // Only ever pending toward closing.
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === "touch") {
        return;
      }
      const shouldBeOpen = shouldFloatingSidebarBeOpen(
        event,
        sidebarRef.current,
        isOpen
          ? [revealZoneRef.current, keepOpenZoneRef.current]
          : [revealZoneRef.current]
      );

      // Already in the desired state: cancel any pending close (the pointer
      // came back before the delay elapsed).
      if (shouldBeOpen === isOpen) {
        clearTimeout(timeout);
        timeout = undefined;
        return;
      }

      if (shouldBeOpen) {
        isOpen = true;
        setIsHoverOpen(true);
        return;
      }

      // Schedule the close once; restarting it on every move outside would
      // postpone closing for as long as the pointer keeps moving.
      if (timeout === undefined) {
        // Cleared by the effect cleanup, which also stops new timers by
        // removing this listener.
        // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
        timeout = setTimeout(() => {
          timeout = undefined;
          isOpen = false;
          setIsHoverOpen(false);
        }, HOVER_CLOSE_DELAY_MS);
      }
    };

    document.addEventListener("pointermove", onPointerMove);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      clearTimeout(timeout);
      // Leaving floating mode (docking, fullscreen, a page hiding the
      // sidebar...) closes it, so it does not reappear away from the cursor the
      // next time it floats.
      setIsHoverOpen(false);
    };
  }, [isFloating]);

  return {
    isVisible: isFloating && isHoverOpen,
    sidebarRef,
    revealZoneRef,
    keepOpenZoneRef,
  };
}
