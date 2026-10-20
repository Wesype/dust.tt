import {
  loadDfm,
  saveDfm,
} from "@app/components/editor/document/dfm_persistence";
import { buildDocumentEditorExtensions } from "@app/components/editor/document/editorExtensions";
import type { MessageDescriptor } from "@lingui/core";
import { Editor } from "@tiptap/core";
import { afterAll, beforeAll, expect, vi } from "vitest";

const translate = (descriptor: MessageDescriptor) =>
  descriptor.message ?? descriptor.id ?? "";

const opened: Editor[] = [];

/** Destroys the editors `openEditor` built, for an `afterEach`. */
export function destroyOpenedEditors() {
  opened.splice(0).forEach((built) => {
    built.view.dom.remove();
    built.destroy();
  });
}

/** An editor on the file `markdown`, mounted in the document, as a browser shows it. */
export function openEditor(
  markdown: string,
  { editable = true, live = false } = {}
) {
  const loaded = loadDfm(markdown);
  if (loaded.isErr()) {
    throw new Error(loaded.error);
  }
  const element = document.body.appendChild(document.createElement("div"));
  const built = new Editor({
    element,
    extensions: buildDocumentEditorExtensions(translate, {
      live,
      resolveImageSource: () => null,
    }),
    content: loaded.value.content,
    editable,
  });
  opened.push(built);
  return built;
}

/** Places the caret at the end of the first text `text`. */
export function caretAfter(built: Editor, text: string) {
  let end: number | null = null;
  built.state.doc.descendants((node, pos) => {
    if (end === null && node.isText && node.text === text) {
      end = pos + text.length;
    }
  });
  if (end === null) {
    throw new Error(`No text "${text}".`);
  }
  built.commands.setTextSelection(end);
}

// Keys go through the view like a browser's.
export function press(built: Editor, key: string, { shiftKey = false } = {}) {
  built.view.someProp("handleKeyDown", (handle) =>
    handle(built.view, new KeyboardEvent("keydown", { key, shiftKey }))
  );
}

export function type(built: Editor, text: string) {
  [...text].forEach((character) => {
    const { from, to } = built.state.selection;
    const handled = built.view.someProp("handleTextInput", (handle) =>
      handle(built.view, from, to, character, () =>
        built.state.tr.insertText(character, from, to)
      )
    );
    if (!handled) {
      built.view.dispatch(built.state.tr.insertText(character, from, to));
    }
  });
}

export const markdown = (built: Editor) => built.getMarkdown().trim();

/** The file a save writes, which must reopen as the editor's document. */
export function saved(built: Editor) {
  const file = saveDfm({ frontMatter: null, anchorOrder: [] }, built.getJSON());
  if (file.isErr()) {
    throw new Error(file.error);
  }
  expect(loadDfm(file.value).isOk()).toBe(true);
  return file.value;
}

/** The texts carrying a comment mark. */
export const commentedTexts = (built: Editor) => {
  const texts: string[] = [];
  built.state.doc.descendants((node) => {
    if (node.marks.some((mark) => mark.type.name === "comment")) {
      texts.push(node.text ?? "");
    }
  });
  return texts;
};

/**
 * A paste of `data`, by format, into `built`. Call `stubClipboardEvent` in the suite first: jsdom
 * has no ClipboardEvent, which ProseMirror builds for a programmatic paste.
 */
export function paste(built: Editor, data: Record<string, string>) {
  clipboard = data;
  const html = data["text/html"];
  if (html) {
    built.view.pasteHTML(html);
  } else {
    built.view.pasteText(data["text/plain"] ?? "");
  }
}

let clipboard: Record<string, string> = {};

export function stubClipboardEvent() {
  beforeAll(() => {
    vi.stubGlobal(
      "ClipboardEvent",
      class extends Event {
        clipboardData = {
          getData: (format: string) => clipboard[format] ?? "",
        };
      }
    );
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });
}

/** jsdom lays nothing out; ProseMirror measures ranges when it scrolls to the selection. */
export function stubRangeLayout() {
  const stubs = [
    ["getClientRects", () => []],
    [
      "getBoundingClientRect",
      () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }),
    ],
  ] as const;
  let originals: (PropertyDescriptor | undefined)[] = [];
  beforeAll(() => {
    originals = stubs.map(([key, value]) => {
      const original = Object.getOwnPropertyDescriptor(Range.prototype, key);
      Object.defineProperty(Range.prototype, key, {
        configurable: true,
        value,
      });
      return original;
    });
  });
  afterAll(() => {
    stubs.forEach(([key], i) => {
      const original = originals[i];
      if (original) {
        Object.defineProperty(Range.prototype, key, original);
      } else {
        Reflect.deleteProperty(Range.prototype, key);
      }
    });
  });
}
