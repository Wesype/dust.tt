import { Icon } from "@sparkle/components/Icon";
import { Tooltip } from "@sparkle/components/Tooltip";
import { cn } from "@sparkle/lib/utils";
import * as React from "react";

export interface PillButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "aria-label"
> {
  icon: React.ComponentType<{ className?: string }>;
  /** Accessible name of the button, also shown as its tooltip. */
  label: string;
  /** Keyboard shortcut hint displayed in the tooltip. */
  tooltipShortcut?: string;
  /** Side of the button the tooltip opens on (defaults to top). */
  tooltipSide?: React.ComponentPropsWithoutRef<typeof Tooltip>["side"];
}

const PillButton = React.forwardRef<HTMLButtonElement, PillButtonProps>(
  ({ className, icon, label, tooltipShortcut, tooltipSide, ...props }, ref) => (
    <Tooltip
      label={label}
      shortcut={tooltipShortcut}
      side={tooltipSide}
      tooltipTriggerAsChild
      trigger={
        <button
          ref={ref}
          type="button"
          aria-label={label}
          className={cn("pill-button touch-hitbox", className)}
          {...props}
        >
          <Icon visual={icon} size="sm" />
        </button>
      }
    />
  )
);
PillButton.displayName = "PillButton";

export { PillButton };
