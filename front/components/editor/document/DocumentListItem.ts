import { isNumber } from "@app/types/shared/utils/general";
import type { RenderContext } from "@tiptap/core";
import { renderNestedMarkdownContent } from "@tiptap/core";
import { ListItem } from "@tiptap/extension-list";

const listMarker = (context: RenderContext) => {
  if (context.parentType !== "orderedList") {
    return "- ";
  }
  const start = context.meta?.parentAttrs?.start;
  return `${(isNumber(start) ? start : 1) + context.index}. `;
};

/** StarterKit's list item, a numbered one counted from its list's `start`, 0 included. */
export const DocumentListItem = ListItem.extend({
  renderMarkdown(node, h, context) {
    return renderNestedMarkdownContent(node, h, listMarker(context), context, {
      alignNestedToPrefix: context.parentType === "orderedList",
    });
  },
});
