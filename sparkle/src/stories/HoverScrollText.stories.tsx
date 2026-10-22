import type { Meta, StoryObj } from "@storybook/react";
import React from "react";

import { HoverScrollText } from "@sparkle/components";

const meta = {
  title: "Effects & Motion/HoverScrollText",
  component: HoverScrollText,
  parameters: {
    docs: {
      description: {
        component: `A single line of text that is ellipsis-truncated at rest and scrolls horizontally to reveal its end while an ancestor \`group\` is hovered. It snaps back to its start when the hover ends.

**When to use**
- For labels in narrow rows (suggestions, sidebar items) where the full text matters but a tooltip is too heavy.

**Guidelines**
- Put a \`group\` class on the hover target (typically the whole row); the text only scrolls while that element is hovered.
- When selection is not a CSS hover (keyboard-driven lists, command palettes), pass \`isActive\` instead: the text scrolls while it is true and hover is ignored.
- Text that fits renders as a plain line, and reduced motion keeps the ellipsis.`,
      },
    },
  },
  argTypes: {
    text: {
      control: "text",
      description: "The text rendered on a single line",
    },
    className: {
      control: "text",
      description: "Classes applied to the clipping wrapper",
    },
  },
  render: (args) => (
    <div className="group flex w-64 items-center rounded-xl p-2 hover:bg-hover">
      <HoverScrollText {...args} />
    </div>
  ),
} satisfies Meta<typeof HoverScrollText>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A label longer than its row: hover the row to scroll it to the end.
 * @summary Truncated text that scrolls on hover.
 */
export const LongText: Story = {
  args: {
    text: "Summarize the latest customer feedback and draft a reply for each ticket",
    className: "copy-sm text-foreground",
  },
};

/**
 * A label that fits its row renders as plain text and does not move on hover.
 * @summary Text that fits stays still.
 */
export const ShortText: Story = {
  args: {
    text: "Draft a reply",
    className: "copy-sm text-foreground",
  },
};

/**
 * A keyboard-selectable row: the description scrolls while the row is
 * selected (`isActive`), not on hover, so a resting pointer never scrolls a
 * second row. The name stays put; only the overflowing description moves.
 * @summary Controlled trigger next to a fixed label.
 */
export const ActiveRow: Story = {
  args: {
    text: "Summarize the latest customer feedback and draft a reply for each ticket",
    className: "copy-sm text-foreground",
  },
  render: () => {
    const [isActive, setIsActive] = React.useState(false);
    return (
      <div className="flex flex-col gap-3">
        <button
          type="button"
          className="w-64 rounded-xl p-2 text-left"
          style={{
            backgroundColor: isActive ? "var(--color-hover)" : undefined,
          }}
          onFocus={() => setIsActive(true)}
          onBlur={() => setIsActive(false)}
        >
          <span className="copy-sm flex min-w-0 items-center gap-1.5">
            <span className="max-w-full shrink-0 truncate font-medium">
              Quarterly planning
            </span>
            <HoverScrollText
              isActive={isActive}
              className="grow text-muted-foreground"
              text="Notes, owners and open questions for the next quarter"
            />
          </span>
        </button>
        <p className="copy-xs text-muted-foreground">
          Focus the row (Tab) to select it; the pointer alone does nothing.
        </p>
      </div>
    );
  },
};
