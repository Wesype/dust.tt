import { cn } from "@dust-tt/sparkle";
import React, { useCallback, useRef } from "react";

interface CommandPaletteAnimatedHeightProps {
  children: React.ReactNode;
}

/**
 * @cc [owner:ClementAupiais,label:react;performance] height-follows-content
 * The container's height MUST settle to the layout height of its children (transform-independent,
 * so a measurement taken during the dialog's zoom-in never leaves it short) after every content
 * change, so nothing stays clipped once the transition ends, and the measurement MUST be written
 * straight to the DOM (no React state) so a resize never re-renders the palette. The container
 * never shrinks its children, so each phase MUST cap its own scroll area relative to the viewport
 * (`90vh` minus its fixed chrome) to keep the natural height within `DialogContent`'s `90vh`.
 */
/**
 * Animates the palette's height when its content changes (results arriving, a filter
 * switching, moving between the search and actions phases). The children render at their
 * natural size at once; only the outer box eases to the new height.
 */
export function CommandPaletteAnimatedHeight({
  children,
}: CommandPaletteAnimatedHeightProps) {
  const outerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const innerRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!node) {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      if (!outerRef.current) {
        return;
      }
      // Layout height, not `getBoundingClientRect()`: the dialog's enter
      // animation zooms the panel from 95%, and a transformed rect measured
      // during that first frame would leave the box 5% short for good.
      const height = entry?.borderBoxSize?.[0]?.blockSize ?? node.offsetHeight;
      outerRef.current.style.height = `${height}px`;
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  return (
    <div
      ref={outerRef}
      className={cn(
        // The first measurement goes from `auto` to a pixel value, which does
        // not animate; every later content change eases to its new height.
        // The resize is feedback to typing, so it leads with its fastest
        // motion (strong ease-out) and stays short; an ease-in-out start reads
        // as lag, especially when results land in several batches.
        "overflow-hidden transition-[height] duration-100 ease-out-quart",
        "motion-reduce:transition-none"
      )}
    >
      <div ref={innerRef}>{children}</div>
    </div>
  );
}
