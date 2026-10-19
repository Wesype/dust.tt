import type { UserMessageTypeWithContentFragments } from "@app/types/assistant/conversation";
import { removeNulls } from "@app/types/shared/utils/general";
import { cn } from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import type { WheelEvent } from "react";
import { useState } from "react";

// Width of a bar by its distance to the closest highlighted bar (dock-style magnification): 20px down
// to 8px in 4px steps over three neighbors, then the resting width. Widths rather than a horizontal
// scale, which would squash the rounded ends of the narrower bars.
const BAR_WIDTH_CLASS_BY_HIGHLIGHT_DISTANCE = ["w-5", "w-4", "w-3", "w-2"];
const RESTING_BAR_WIDTH_CLASS = "w-1.5";

function getBarWidthClass(index: number, highlightedIndices: number[]): string {
  const distance = Math.min(
    ...highlightedIndices.map((highlightedIndex) =>
      Math.abs(index - highlightedIndex)
    )
  );

  return (
    BAR_WIDTH_CLASS_BY_HIGHLIGHT_DISTANCE[distance] ?? RESTING_BAR_WIDTH_CLASS
  );
}

interface MessageTimelineProps {
  messages: UserMessageTypeWithContentFragments[];
  activeMessageId: string | null;
  onMessageClick: (message: UserMessageTypeWithContentFragments) => void;
  onWheel: (event: WheelEvent<HTMLElement>) => void;
}

export function MessageTimeline({
  messages,
  activeMessageId,
  onMessageClick,
  onWheel,
}: MessageTimelineProps) {
  const { t } = useLingui();
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);

  const activeIndex = messages.findIndex((m) => m.sId === activeMessageId);
  // The bar of the message in view stays highlighted while another bar is hovered, each one
  // magnifying its own neighbors.
  const highlightedIndices = removeNulls([
    hoveredIndex,
    activeIndex === -1 ? null : activeIndex,
  ]);

  // The timeline sits in the right gutter of the list, clear of the scrollbar. The container's padding
  // is the gutter the bars need on each side (16px inset, 20px bar, 20px clearance), so the timeline
  // only shows when what remains fits the message column: `@min-conversation` compares the container
  // to `--container-conversation` (`max-w-conversation`), not to the `conversation` named container.
  return (
    <div className="pointer-events-none absolute inset-0 px-14 @container">
      <nav
        aria-label={t`Message timeline`}
        className={cn(
          "absolute inset-y-0 right-4 hidden w-8 flex-col justify-center",
          "@min-conversation:flex"
        )}
      >
        <div
          className="pointer-events-auto flex max-h-full flex-col overflow-y-auto scrollbar-hide"
          onMouseLeave={() => setHoveredIndex(null)}
          onWheel={onWheel}
        >
          {messages.map((message, index) => {
            const messageNumber = index + 1;

            return (
              <button
                key={message.sId}
                type="button"
                aria-label={t`Go to message ${messageNumber}`}
                aria-current={index === activeIndex ? "location" : undefined}
                className="flex h-3 min-h-1 w-full items-center justify-end outline-hidden"
                onClick={() => onMessageClick(message)}
                onMouseEnter={() => setHoveredIndex(index)}
                onFocus={() => setHoveredIndex(index)}
                onBlur={() => setHoveredIndex(null)}
              >
                <span
                  className={cn(
                    "h-0.5 rounded-full",
                    getBarWidthClass(index, highlightedIndices),
                    "transition-[width,background-color] duration-150 ease-enter",
                    "motion-reduce:transition-none",
                    index === hoveredIndex || index === activeIndex
                      ? "bg-foreground"
                      : "bg-muted-foreground/40"
                  )}
                />
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
