import {
  isEmptyParagraphMarker,
  KEEPS_EMPTY_ATTR,
} from "@app/components/editor/document/DocumentParagraph";
import { isNumber, isString } from "@app/types/shared/utils/general";
import type {
  Command,
  JSONContent,
  MarkdownToken,
  RenderContext,
  SingleCommands,
} from "@tiptap/core";
import {
  InputRule,
  mergeAttributes,
  renderNestedMarkdownContent,
} from "@tiptap/core";
import type { ListItemOptions } from "@tiptap/extension-list";
import { ListItem } from "@tiptap/extension-list";
import type { Node as ProseMirrorNode, ResolvedPos } from "@tiptap/pm/model";
import type { Transaction } from "@tiptap/pm/state";

export const LIST_ITEM_NODE_NAME = "listItem";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    documentListItem: {
      /**
       * Makes the list items of the selection tasks, or plain items when they all are tasks,
       * wrapping the selection in a bulleted list first when it is in none.
       */
      toggleTaskList: () => ReturnType;
      /**
       * Makes the list items of the selection numbered tasks, or plain items when they all are
       * tasks of a numbered list, numbering their list or wrapping the selection in a numbered
       * list first when it is in none.
       */
      toggleNumberedTaskList: () => ReturnType;
    };
  }
}

const isTaskCheckbox = (element: Element | null) =>
  element?.matches("input[type=checkbox]") ?? false;

// A task item copied from the editor carries its data attributes; one copied from GitHub holds a
// checkbox as its first child.
const htmlCheckbox = (element: HTMLElement) =>
  [element.firstElementChild, element.firstElementChild?.firstElementChild]
    .filter((child): child is Element => child !== null && child !== undefined)
    .find(isTaskCheckbox) ?? null;

const isCheckbox = (token: MarkdownToken) => token.type === "checkbox";

/**
 * A task item's tokens without its checkbox, which marked puts either first in the item or first
 * in the item's first paragraph or text.
 */
export const taskItemTokens = (token: MarkdownToken): MarkdownToken[] => {
  const [first, ...rest] = token.tokens ?? [];
  if (!token.task || !first) {
    return token.tokens ?? [];
  }
  if (isCheckbox(first)) {
    return rest;
  }
  return first.tokens?.some(isCheckbox)
    ? [
        { ...first, tokens: first.tokens.filter((t) => !isCheckbox(t)) },
        ...rest,
      ]
    : (token.tokens ?? []);
};

/** GFM reads a task marker only when text follows it on its line. */
export const isWritableTask = (node: JSONContent) =>
  node.attrs?.task === true && (node.content?.[0]?.content?.length ?? 0) > 0;

const taskMarker = (node: JSONContent) =>
  isWritableTask(node) ? (node.attrs?.checked ? "[x] " : "[ ] ") : "";

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

const isNode = (target: EventTarget | null): target is Node =>
  target instanceof globalThis.Node;

/** The text of an item's first paragraph, images read as their alt text. */
const itemText = (item: ProseMirrorNode) => {
  const paragraph = item.firstChild;
  return paragraph
    ? paragraph
        .textBetween(0, paragraph.content.size, " ", (leaf) =>
          isString(leaf.attrs.alt) ? ` ${leaf.attrs.alt} ` : ""
        )
        .replace(/\s+/g, " ")
        .trim()
    : "";
};

/** The list item nearest to each textblock of the selection. */
const selectedListItems = (tr: Transaction, type: ProseMirrorNode["type"]) => {
  const items = new Map<number, ProseMirrorNode>();
  const addItemAround = ($pos: ResolvedPos) => {
    for (let depth = $pos.depth; depth > 0; depth--) {
      if ($pos.node(depth).type === type) {
        items.set($pos.before(depth), $pos.node(depth));
        return;
      }
    }
  };
  const { from, to, $from } = tr.selection;
  addItemAround($from);
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isTextblock) {
      addItemAround(tr.doc.resolve(pos + 1));
      return false;
    }
    return true;
  });
  return [...items].map(([pos, node]) => ({ node, pos }));
};

/**
 * StarterKit's list item, which is a task when `task` is set, done when `checked` also is. A
 * task item is written `- [ ] ` or `1. [x] `, its content aligned with the list marker, and an
 * empty one as an empty item.
 */
/**
 * @cc [owner:rfrenoy,label:product] document-empty-list-item
 * An item whose first paragraph consists only of `&nbsp;` or a non-breaking space MUST read with
 * an empty first paragraph, as TipTap's paragraph reads one. Any other text, the marker escaped
 * included, MUST read as text.
 */
export const DocumentListItem = ListItem.extend<
  ListItemOptions & {
    /** The name of a task's checkbox when its item has no text. */
    emptyTaskLabel: string;
  }
>({
  addOptions() {
    return { ...ListItem.options, emptyTaskLabel: "Task" };
  },

  addAttributes() {
    return {
      ...this.parent?.(),
      task: {
        default: false,
        keepOnSplit: true,
        parseHTML: (element) =>
          element.dataset.task === "true" || htmlCheckbox(element) !== null,
        renderHTML: ({ task }) => (task ? { "data-task": "true" } : {}),
      },
      checked: {
        default: false,
        keepOnSplit: false,
        parseHTML: (element) =>
          element.dataset.checked === "true" ||
          htmlCheckbox(element)?.hasAttribute("checked") === true,
        renderHTML: ({ task, checked }) =>
          task && checked ? { "data-checked": "true" } : {},
      },
    };
  },

  parseMarkdown(token, helpers) {
    const itemToken = { ...token, tokens: taskItemTokens(token) };
    const parsed = this.parent?.(itemToken, helpers) ?? [];
    if (Array.isArray(parsed) || "mark" in parsed) {
      return parsed;
    }
    const [first, ...others] = parsed.content ?? [];
    const item =
      opensWithEmptyParagraphMarker(itemToken) && isMarkerParagraph(first)
        ? { ...parsed, content: [{ type: "paragraph" }, ...others] }
        : parsed;
    return token.task
      ? {
          ...item,
          attrs: { ...item.attrs, task: true, checked: token.checked === true },
        }
      : item;
  },

  // The task marker follows the list marker, which alone sets where nested content aligns.
  renderMarkdown(node, h, context) {
    const prefix = listMarker(context);
    const rendered = renderNestedMarkdownContent(node, h, prefix, context, {
      alignNestedToPrefix: context.parentType === "orderedList",
    });
    return `${prefix}${taskMarker(node)}${rendered.slice(prefix.length)}`;
  },

  addInputRules() {
    return [
      new InputRule({
        find: /^\[([ xX]?)\]\s$/,
        handler: ({ state, range, match }) => {
          const $from = state.doc.resolve(range.from);
          const item = $from.node(-1);
          if (
            $from.depth < 2 ||
            item.type !== this.type ||
            $from.index(-1) !== 0 ||
            item.attrs.task
          ) {
            return null;
          }
          state.tr
            .delete(range.from, range.to)
            .setNodeMarkup($from.before(-1), undefined, {
              ...item.attrs,
              task: true,
              checked: match[1] === "x" || match[1] === "X",
            });
        },
      }),
    ];
  },

  addCommands() {
    const setTasks = (
      items: { node: ProseMirrorNode; pos: number }[],
      task: boolean,
      tr: Transaction
    ) =>
      items.forEach(({ node, pos }) =>
        tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          task,
          checked: task && node.attrs.task && node.attrs.checked,
        })
      );
    const toggleTasks =
      (
        isInList: (tr: Transaction, pos: number) => boolean,
        toggleList: (commands: SingleCommands) => boolean
      ): Command =>
      ({ commands, tr, dispatch }) => {
        const items = selectedListItems(tr, this.type);
        if (items.length > 0 && items.every(({ pos }) => isInList(tr, pos))) {
          if (dispatch) {
            setTasks(items, !items.every(({ node }) => node.attrs.task), tr);
          }
          return true;
        }
        if (!toggleList(commands)) {
          return false;
        }
        if (dispatch) {
          setTasks(selectedListItems(tr, this.type), true, tr);
        }
        return true;
      };
    return {
      toggleTaskList: () =>
        toggleTasks(
          () => true,
          (commands) => commands.toggleBulletList()
        ),
      toggleNumberedTaskList: () =>
        toggleTasks(
          (tr, pos) => tr.doc.resolve(pos).parent.type.name === "orderedList",
          (commands) => commands.toggleOrderedList()
        ),
    };
  },

  /**
   * @cc [owner:rfrenoy,label:product] document-task-item-read-only
   * In an editor that is not editable, clicking or pressing Space on a task's checkbox MUST NOT
   * change the document nor the checkbox's state. In an editable one, it MUST toggle only that
   * item's `checked`.
   */
  addNodeView() {
    return ({ node, getPos, editor, HTMLAttributes }) => {
      const item = document.createElement("li");
      Object.entries(
        mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)
      ).forEach(([name, value]) => item.setAttribute(name, String(value)));

      if (!node.attrs.task) {
        return {
          dom: item,
          contentDOM: item,
          update: (updated) =>
            updated.type === node.type && !updated.attrs.task,
        };
      }

      item.classList.add("[ul>&]:list-none");
      const box = document.createElement("label");
      box.contentEditable = "false";
      box.className =
        "float-left flex h-[1.5em] items-center [ol>li>&]:mr-2 [ul>li>&]:-ml-6 [ul>li>&]:w-6 my-1";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "size-4 cursor-pointer accent-foreground";
      box.append(checkbox);
      const content = document.createElement("div");
      content.className = "flow-root [&>p]:my-1 [&>ul]:my-1 [&>ol]:my-1";
      item.append(box, content);

      let current = node;
      const render = () => {
        checkbox.checked = current.attrs.checked === true;
        checkbox.setAttribute(
          "aria-label",
          itemText(current) || this.options.emptyTaskLabel
        );
      };
      render();

      checkbox.addEventListener("mousedown", (event) => event.preventDefault());
      checkbox.addEventListener("click", (event) => {
        if (!editor.isEditable) {
          event.preventDefault();
        }
      });
      checkbox.addEventListener("change", () => {
        const pos = getPos();
        if (!editor.isEditable || !isNumber(pos)) {
          render();
          return;
        }
        const { checked } = checkbox;
        editor
          .chain()
          .focus(undefined, { scrollIntoView: false })
          .command(({ tr }) => {
            tr.setNodeAttribute(pos, "checked", checked);
            return true;
          })
          .run();
      });

      return {
        dom: item,
        contentDOM: content,
        update: (updated) => {
          if (updated.type !== node.type || !updated.attrs.task) {
            return false;
          }
          current = updated;
          render();
          return true;
        },
        stopEvent: (event) =>
          isNode(event.target) && box.contains(event.target),
        ignoreMutation: (mutation) =>
          mutation.type !== "selection" && box.contains(mutation.target),
      };
    };
  },
});
