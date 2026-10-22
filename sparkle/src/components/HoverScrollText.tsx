import { cn } from "@sparkle/lib/utils";
import { useReducedMotion } from "framer-motion";
import type { CSSProperties } from "react";
import React, { useLayoutEffect, useRef, useState } from "react";

const SCROLL_SPEED_PX_PER_SECOND = 50;

interface HoverScrollStyle extends CSSProperties {
  "--scroll-distance": string;
  "--scroll-duration": string;
}

function hoverScrollStyle(overflowPx: number): HoverScrollStyle {
  return {
    "--scroll-distance": `${overflowPx}px`,
    "--scroll-duration": `${(overflowPx / SCROLL_SPEED_PX_PER_SECOND) * 1000}ms`,
  };
}

interface HoverScrollTextBaseProps {
  className?: string;
  /**
   * Controlled trigger: when given, the text scrolls while `isActive` is true instead of while
   * an ancestor `group` is hovered, e.g. for rows selected by keyboard.
   */
  isActive?: boolean;
}

export interface HoverScrollTextProps extends HoverScrollTextBaseProps {
  text: string;
}

// Scrolling classes while triggered; the transition only runs while triggered so the text
// snaps back when the trigger ends. `whitespace-nowrap` is restated because tailwind-merge drops
// `truncate` once an unprefixed overflow class follows it.
const SCROLLING_CLASSES = cn(
  "overflow-visible text-clip whitespace-nowrap",
  "translate-x-[calc(var(--scroll-distance)*-1)]",
  "transition-transform delay-300 duration-(--scroll-duration) ease-linear"
);
const GROUP_HOVER_SCROLLING_CLASSES = cn(
  "group-hover:overflow-visible group-hover:text-clip",
  "group-hover:translate-x-[calc(var(--scroll-distance)*-1)]",
  "group-hover:transition-transform group-hover:delay-300 group-hover:duration-(--scroll-duration) group-hover:ease-linear"
);

/**
 * @cc [owner:adrsimon;ClementAupiais,label:react;product] scrolls-only-when-truncated
 * The text MUST scroll forward only while triggered and overflowing its box. The trigger is an
 * ancestor `group` being hovered, or, when `isActive` is given, `isActive` being true (hover is
 * then ignored). When the trigger ends it snaps back to its start. Without overflow, or under
 * reduced motion, it MUST render as a plain ellipsis-truncated line.
 */
export function HoverScrollText({
  className,
  isActive,
  text,
}: HoverScrollTextProps) {
  const shouldReduceMotion = useReducedMotion();
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflowPx, setOverflowPx] = useState(0);

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element) {
      return;
    }

    const measure = () =>
      setOverflowPx(element.scrollWidth - element.clientWidth);
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => observer.disconnect();
  }, [text]);

  const canScroll = overflowPx > 0 && !shouldReduceMotion;
  const isControlled = isActive !== undefined;

  return (
    <span className={cn("block min-w-0 overflow-hidden", className)}>
      <span
        ref={textRef}
        className={cn(
          "block truncate",
          canScroll &&
            (isControlled
              ? isActive && SCROLLING_CLASSES
              : GROUP_HOVER_SCROLLING_CLASSES)
        )}
        style={canScroll ? hoverScrollStyle(overflowPx) : undefined}
      >
        {text}
      </span>
    </span>
  );
}
