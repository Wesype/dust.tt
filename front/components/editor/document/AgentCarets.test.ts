import {
  agentCaretKey,
  agentCaretsPlugin,
  removedText,
  withAgentCarets,
} from "@app/components/editor/document/AgentCarets";
import {
  documentSchema,
  parseDocumentContent,
} from "@app/components/editor/document/content";
import { caretColor } from "@app/lib/client/collab/messages";
import { CollabAgentFactory } from "@app/tests/utils/CollabAgentFactory";
import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { afterEach, describe, expect, it } from "vitest";

const AGENT = CollabAgentFactory.build({ agentId: "dust", name: "Dust" });

const views: EditorView[] = [];

afterEach(() => {
  views.splice(0).forEach((view) => view.destroy());
});

function parse(markdown: string) {
  const parsed = parseDocumentContent(markdown);
  if (parsed.isErr()) {
    throw new Error(parsed.error);
  }
  return documentSchema.nodeFromJSON(parsed.value.document);
}

function editor(markdown: string) {
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({
      doc: parse(markdown),
      plugins: [agentCaretsPlugin("usr_me")],
    }),
  });
  views.push(view);
  return view;
}

const edited = (typing: boolean) => ({
  type: "edited" as const,
  agent: AGENT,
  ranges: [{ from: 1, to: 7 }],
  typing,
});

const typed = (
  view: EditorView,
  typed: { revealed?: number; erased?: number; settled?: boolean }
) =>
  view.dispatch(
    withAgentCarets(view.state, {
      type: "typed",
      caretKey: agentCaretKey(AGENT),
      typed,
    })
  );

const shownText = (view: EditorView) => {
  const hidden = [...view.dom.querySelectorAll<HTMLElement>("*")].filter(
    (element) => element.style.display === "none"
  );
  const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!hidden.some((element) => element.contains(node))) {
      text += node.textContent;
    }
  }
  return text;
};

const textBefore = (view: EditorView, caret: Element) => {
  const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT);
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (
      !caret.contains(node) &&
      caret.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING
    ) {
      text += node.textContent;
    }
  }
  return text;
};

const carets = (view: EditorView) =>
  [...view.dom.querySelectorAll(".collaboration-carets__caret")].map(
    (caret) => ({
      label: caret.textContent,
      before: textBefore(view, caret),
    })
  );

const bands = (view: EditorView) =>
  [...view.dom.querySelectorAll<HTMLElement>(".collab-typed")].map((band) => ({
    text: band.textContent,
    settled: band.hasAttribute("data-settled"),
  }));

describe("agentCaretsPlugin", () => {
  it("shows no agent before its first edit, then where its edit ends", () => {
    const view = editor("Hello world.");

    view.dispatch(
      withAgentCarets(view.state, { type: "activity", agent: AGENT })
    );
    expect(carets(view)).toEqual([]);

    view.dispatch(withAgentCarets(view.state, edited(false)));
    expect(carets(view)).toEqual([{ label: "Dust · Ada", before: "Hello " }]);
  });

  it("follows later changes of the document, without changing it", () => {
    const view = editor("Hello world.");
    const { doc, selection } = view.state;
    view.dispatch(withAgentCarets(view.state, edited(false)));
    expect(view.state.doc).toBe(doc);
    expect(view.state.selection.eq(selection)).toBe(true);

    view.dispatch(view.state.tr.insertText("Oh. ", 1));
    expect(carets(view)).toEqual([
      { label: "Dust · Ada", before: "Oh. Hello " },
    ]);
  });

  it("stays in place through a change of the session, which replaces the whole document", () => {
    const view = editor("Hello world.\n\nBye.");
    view.dispatch(withAgentCarets(view.state, edited(false)));

    const changed = parse("Hello world.\n\nBye now.");
    view.dispatch(
      view.state.tr
        .replaceWith(0, view.state.doc.content.size, changed.content)
        .setMeta(ySyncPluginKey, { isChangeOrigin: true })
    );
    expect(carets(view)).toEqual([{ label: "Dust · Ada", before: "Hello " }]);
  });

  it("keeps typing in place through this editor's undo, which also replaces the whole document", () => {
    const view = editor("One.\n\nHello world.");
    view.dispatch(
      withAgentCarets(view.state, {
        type: "edited",
        agent: AGENT,
        ranges: [{ from: 7, to: 13 }],
        typing: true,
      })
    );
    typed(view, { revealed: 3 });

    const undone = parse("One more.\n\nHello world.");
    view.dispatch(
      view.state.tr
        .replaceWith(0, view.state.doc.content.size, undone.content)
        .setMeta(ySyncPluginKey, {
          isChangeOrigin: true,
          isUndoRedoOperation: true,
        })
    );
    expect(shownText(view)).toBe("One more.HelDust · Adaworld.");
  });

  it("keeps its place in a block the session left unchanged between two it changed", () => {
    const view = editor("One.\n\nHello world.\n\nTwo.");
    view.dispatch(
      withAgentCarets(view.state, {
        type: "edited",
        agent: AGENT,
        ranges: [{ from: 7, to: 13 }],
        typing: true,
      })
    );
    typed(view, { revealed: 3 });

    const changed = parse("One more.\n\nHello world.\n\nTwo more.");
    view.dispatch(
      view.state.tr
        .replaceWith(0, view.state.doc.content.size, changed.content)
        .setMeta(ySyncPluginKey, { isChangeOrigin: true })
    );
    expect(shownText(view)).toBe("One more.HelDust · Adaworld.Two more.");
  });

  it("keeps its place in a nested block the session left unchanged between two it changed", () => {
    const view = editor("- One.\n- Hello world.\n- Two.");
    view.dispatch(
      withAgentCarets(view.state, {
        type: "edited",
        agent: AGENT,
        ranges: [{ from: 11, to: 17 }],
        typing: true,
      })
    );
    typed(view, { revealed: 3 });

    const changed = parse("- One more.\n- Hello world.\n- Two more.");
    view.dispatch(
      view.state.tr
        .replaceWith(0, view.state.doc.content.size, changed.content)
        .setMeta(ySyncPluginKey, { isChangeOrigin: true })
    );
    expect(shownText(view)).toBe("One more.HelDust · Adaworld.Two more.");
  });

  it("fades out when the agent leaves, and comes back where it was on its next activity", () => {
    const view = editor("Hello world.");
    view.dispatch(withAgentCarets(view.state, edited(false)));

    view.dispatch(
      withAgentCarets(view.state, {
        type: "end",
        caretKey: agentCaretKey(AGENT),
        presence: "leaving",
      })
    );
    expect(
      [...view.dom.querySelectorAll(".collaboration-carets__caret")].map(
        (caret) => caret.classList.contains("collab-caret-leaving")
      )
    ).toEqual([true]);

    view.dispatch(
      withAgentCarets(view.state, {
        type: "end",
        caretKey: agentCaretKey(AGENT),
        presence: "gone",
      })
    );
    expect(carets(view)).toEqual([]);

    view.dispatch(view.state.tr.insertText("Oh. ", 1));
    view.dispatch(
      withAgentCarets(view.state, { type: "activity", agent: AGENT })
    );
    expect(carets(view)).toEqual([
      { label: "Dust · Ada", before: "Oh. Hello " },
    ]);
  });

  it("types the edit's text in, the caret at the end of what is revealed, in the agent's color", () => {
    const view = editor("Hello world.");
    view.dispatch(withAgentCarets(view.state, edited(true)));
    expect(shownText(view)).toBe("Dust · Adaworld.");

    typed(view, { revealed: 3 });
    expect(shownText(view)).toBe("HelDust · Adaworld.");
    expect(
      [...view.dom.querySelectorAll<HTMLElement>(".collab-typed")].map((band) =>
        band.style.getPropertyValue("--typed-color")
      )
    ).toEqual([caretColor("dust")]);

    typed(view, { revealed: 6 });
    expect(shownText(view)).toBe("Hello Dust · Adaworld.");
    expect(view.dom.querySelector("[style*='display: none']")).toBeNull();
  });

  it("shows the agent working for this editor's user with its own caret, in the highlight color", () => {
    const view = editor("Hello world.");
    view.dispatch(withAgentCarets(view.state, edited(true)));
    view.dispatch(
      withAgentCarets(view.state, {
        type: "edited",
        agent: { ...AGENT, userId: "usr_me" },
        ranges: [{ from: 7, to: 12 }],
        typing: true,
      })
    );

    expect(
      [
        ...view.dom.querySelectorAll<HTMLElement>(
          ".collaboration-carets__caret"
        ),
      ].map((caret) => caret.style.borderColor)
    ).toEqual([
      expect.not.stringContaining("highlight"),
      "var(--color-highlight)",
    ]);
  });

  it("reveals the rest of an edit at once when the agent edits again", () => {
    const view = editor("Hello world.");
    view.dispatch(withAgentCarets(view.state, edited(true)));
    view.dispatch(withAgentCarets(view.state, edited(false)));
    expect(shownText(view)).toBe("Hello Dust · Adaworld.");
  });

  it("bands what is revealed in each block, settling a block once a later one starts", () => {
    const view = editor("One two.\n\nThree.");
    view.dispatch(
      withAgentCarets(view.state, {
        type: "edited",
        agent: AGENT,
        ranges: [
          { from: 1, to: 9 },
          { from: 11, to: 17 },
        ],
        typing: true,
      })
    );

    typed(view, { revealed: 4 });
    expect(bands(view)).toEqual([{ text: "One ", settled: false }]);

    typed(view, { revealed: 8 });
    expect(bands(view)).toEqual([{ text: "One two.", settled: false }]);
    expect(
      view.dom.querySelector("p")?.querySelector(".collaboration-carets__caret")
    ).not.toBeNull();

    typed(view, { revealed: 14 });
    expect(bands(view)).toEqual([
      { text: "One two.", settled: true },
      { text: "Three.", settled: false },
    ]);

    typed(view, { settled: true });
    expect(bands(view)).toEqual([
      { text: "One two.", settled: true },
      { text: "Three.", settled: true },
    ]);

    view.dispatch(
      withAgentCarets(view.state, {
        type: "end",
        caretKey: agentCaretKey(AGENT),
      })
    );
    expect(bands(view)).toEqual([]);
  });

  it("erases the text the edit removed from its end, then types the new text", () => {
    const view = editor("Hello big world.");
    const before = view.state.doc;
    view.dispatch(
      view.state.tr
        .insertText("small", 7, 10)
        .setMeta(ySyncPluginKey, { isChangeOrigin: true })
    );
    const removed = removedText(
      { before, after: view.state.doc },
      view.state.doc,
      [{ from: 7, to: 12 }]
    );
    view.dispatch(
      withAgentCarets(view.state, {
        type: "edited",
        agent: AGENT,
        ranges: [{ from: 7, to: 12 }],
        typing: true,
        removed,
      })
    );
    expect(shownText(view)).toBe("Hello bigDust · Ada world.");

    typed(view, { erased: 2 });
    expect(shownText(view)).toBe("Hello bDust · Ada world.");

    typed(view, { erased: 3 });
    typed(view, { revealed: 5 });
    expect(shownText(view)).toBe("Hello smallDust · Ada world.");
  });
});

describe("removedText", () => {
  const change = (before: string, after: string) => ({
    before: parse(before),
    after: parse(after),
  });

  it("finds what a changed block lost, where its kept start and end meet", () => {
    const { before, after } = change(
      "Intro.\n\nHello big world.\n\nEnd.",
      "Intro.\n\nHello small world.\n\nEnd."
    );
    const [removed, ...rest] = removedText({ before, after }, after, [
      { from: 15, to: 20 },
    ]);
    expect(rest).toEqual([]);
    expect(removed.at).toBe(15);
    expect(removed.content.textBetween(0, removed.content.size)).toBe("big");
  });

  it("finds nothing when the document changed since, or for a new block", () => {
    const { before, after } = change("Hello.", "Hello.\n\nNew.");
    expect(
      removedText({ before, after }, after, [{ from: 9, to: 13 }])
    ).toEqual([]);

    const later = parse("Hello big world.");
    const stale = change("Hello world.", "Hello big world.");
    expect(removedText(stale, later, [{ from: 7, to: 10 }])).toEqual([]);
  });
});
