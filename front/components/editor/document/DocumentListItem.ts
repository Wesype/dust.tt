import {
  isEmptyParagraphMarker,
  KEEPS_EMPTY_ATTR,
} from "@app/components/editor/document/DocumentParagraph";
import { isNumber } from "@app/types/shared/utils/general";
import type { JSONContent, MarkdownToken, RenderContext } from "@tiptap/core";
import { renderNestedMarkdownContent } from "@tiptap/core";
import { ListItem } from "@tiptap/extension-list";

const ALTERNATE_MARKER_ATTR = "alternateMarker";

const isList = (node: JSONContent | undefined) =>
  node?.type === "bulletList" || node?.type === "orderedList";

const listMarker = (context: RenderContext) => {
  const alternate = context.meta?.parentAttrs?.[ALTERNATE_MARKER_ATTR] === true;
  if (context.parentType !== "orderedList") {
    return alternate ? "* " : "- ";
  }
  const start = context.meta?.parentAttrs?.start;
  return `${(isNumber(start) ? start : 1) + context.index}${alternate ? ")" : "."} `;
};

const isEmptyParagraph = (node: JSONContent | undefined) =>
  node?.type === "paragraph" && !node.content?.length;

const withAttr = (node: JSONContent, name: string): JSONContent => ({
  ...node,
  attrs: { ...node.attrs, [name]: true },
});

/**
 * @cc [owner:rfrenoy,label:product] document-adjacent-lists
 * Lists of the same type MUST be written so each reads back as its own list: a list directly after
 * one of its type with the other marker of its kind, `*` for `-` and `)` for `.`, alternating along
 * a run of such lists, and a single empty paragraph between two of them as `&nbsp;`. Every other
 * list MUST be written with `-` or `.`.
 */
export const withSeparatedLists = (node: JSONContent): JSONContent => {
  const children = node.content;
  if (!children) {
    return node;
  }
  let alternate = false;
  const content = children.map((child, index) => {
    const previous = children[index - 1];
    const next = children[index + 1];
    alternate = isList(child) && previous?.type === child.type && !alternate;
    const written = withSeparatedLists(child);
    if (alternate) {
      return withAttr(written, ALTERNATE_MARKER_ATTR);
    }
    return isEmptyParagraph(child) &&
      isList(previous) &&
      previous?.type === next?.type
      ? withAttr(written, KEEPS_EMPTY_ATTR)
      : written;
  });
  return { ...node, content };
};

const opensWithEmptyParagraphMarker = (token: MarkdownToken) => {
  const [first] = token.tokens ?? [];
  return (
    (first?.type === "text" || first?.type === "paragraph") &&
    isEmptyParagraphMarker(first.raw?.replace(/\n+$/, ""))
  );
};

const isMarkerParagraph = (node: JSONContent | undefined) => {
  const [text, ...rest] = node?.content ?? [];
  return (
    node?.type === "paragraph" &&
    rest.length === 0 &&
    text?.type === "text" &&
    isEmptyParagraphMarker(text.text) &&
    !text.marks?.length
  );
};

/** StarterKit's list item, a numbered one counted from its list's `start`, 0 included. */
/**
 * @cc [owner:rfrenoy,label:product] document-empty-list-item
 * An item whose first paragraph consists only of `&nbsp;` or a non-breaking space MUST read with
 * an empty first paragraph, as TipTap's paragraph reads one. Any other text, the marker escaped
 * included, MUST read as text.
 */
export const DocumentListItem = ListItem.extend({
  parseMarkdown(token, helpers) {
    const parsed = this.parent?.(token, helpers) ?? [];
    if (
      Array.isArray(parsed) ||
      "mark" in parsed ||
      !opensWithEmptyParagraphMarker(token)
    ) {
      return parsed;
    }
    const [first, ...rest] = parsed.content ?? [];
    return isMarkerParagraph(first)
      ? { ...parsed, content: [{ type: "paragraph" }, ...rest] }
      : parsed;
  },

  renderMarkdown(node, h, context) {
    return renderNestedMarkdownContent(node, h, listMarker(context), context, {
      alignNestedToPrefix: context.parentType === "orderedList",
    });
  },
});
