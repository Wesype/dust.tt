import { ArrowRight, Button, cn, KeyboardShortcut } from "@dust-tt/sparkle";
import { useLingui } from "@lingui/react/macro";
import React, { createContext, useContext } from "react";

const ItemRowSelectedContext = createContext(false);

/**
 * Whether the enclosing `ItemRow` is selected (by keyboard or by the pointer moving onto it).
 * Lets row content react to selection, e.g. scroll overflowing text, without each caller
 * threading `isSelected` through.
 */
export function useItemRowSelected(): boolean {
  return useContext(ItemRowSelectedContext);
}

interface ItemRowProps {
  isSelected: boolean;
  onClick: () => void;
  onMouseMove: () => void;
  /** When set, shows a trailing arrow control to open the actions phase. */
  onOpenActions?: () => void;
  children: React.ReactNode;
}

export const ItemRow = React.forwardRef<HTMLDivElement, ItemRowProps>(
  function ItemRow(
    { isSelected, onClick, onMouseMove, onOpenActions, children },
    ref
  ) {
    const { t } = useLingui();
    return (
      <div
        ref={ref}
        className={cn(
          "flex h-12 cursor-pointer items-center gap-2.5 rounded-lg px-3 text-sm transition-colors duration-150",
          "text-foreground",
          // Selection only — avoid CSS :hover so keyboard selection and a
          // stationary mouse pointer can't highlight two rows at once.
          isSelected && "bg-hover"
        )}
        onClick={onClick}
        onMouseMove={onMouseMove}
      >
        <div className="flex min-w-0 grow items-center gap-2.5">
          <ItemRowSelectedContext.Provider value={isSelected}>
            {children}
          </ItemRowSelectedContext.Provider>
        </div>
        {onOpenActions && (
          <Button
            variant="outline"
            size="xs"
            icon={ArrowRight}
            aria-label={t`More actions`}
            // Keep the button mounted so showing it on selection doesn't shift layout.
            className={cn(!isSelected && "invisible")}
            tabIndex={isSelected ? undefined : -1}
            onClick={(e) => {
              e.stopPropagation();
              onOpenActions();
            }}
          />
        )}
      </div>
    );
  }
);

interface ItemTitleProps {
  children: React.ReactNode;
}

export function ItemTitle({ children }: ItemTitleProps) {
  return (
    <div className="px-3 pb-1.5 pt-1 text-xs font-semibold text-muted-foreground">
      {children}
    </div>
  );
}

interface ItemEmptyStateProps {
  children: React.ReactNode;
}

export function ItemEmptyState({ children }: ItemEmptyStateProps) {
  return (
    <div className="px-3 py-8 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

interface KeyboardHint {
  keys: string[];
  label: string;
  textSize?: "text-xs" | "text-sm" | "text-base";
}

export function KeyboardHints({ hints }: { hints: KeyboardHint[] }) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-4 border-t px-4 py-2",
        "border-separator",
        "text-xs text-muted-foreground"
      )}
    >
      {hints.map((hint) => (
        <div key={hint.label} className="flex items-center gap-1.5">
          {hint.keys.map((key) => (
            <KeyboardShortcut
              key={key}
              shortcut={key}
              className={cn(
                "inline-flex h-6 min-w-6 items-center justify-center rounded border px-1",
                "border-separator shadow-xs",
                hint.textSize ?? "text-xs"
              )}
            />
          ))}
          <span>{hint.label}</span>
        </div>
      ))}
    </div>
  );
}
