import {
  caretAfter,
  commentedTexts,
  destroyOpenedEditors,
  markdown,
  openEditor,
  paste,
  press,
  saved,
  stubClipboardEvent,
} from "@app/components/editor/document/editor.test_utils";
import { afterEach, describe, expect, it } from "vitest";

afterEach(destroyOpenedEditors);

/** An editor on `Intro`, the caret in an empty paragraph after it. */
function afterIntro({ live = false } = {}) {
  const built = openEditor("Intro\n", { live });
  caretAfter(built, "Intro");
  press(built, "Enter");
  return built;
}

const hasNumberedList = (built: ReturnType<typeof openEditor>) =>
  built.getJSON().content?.some((node) => node.type === "orderedList");

describe("pasted numbered lists", () => {
  stubClipboardEvent();

  it("reads a numbered list pasted as text", () => {
    const built = afterIntro();

    paste(built, { "text/plain": "1. Collect\n2. Write\n" });

    expect(markdown(built)).toBe("Intro\n\n1. Collect\n2. Write");
  });

  it("reads a pasted numbered item holding only an image as the file would", () => {
    const built = afterIntro();

    paste(built, {
      "text/plain": "1. ![Chart](pod-x/chart.png)\n\n2. Next\n",
    });

    expect(saved(built)).toBe(
      "Intro\n\n1. ![Chart](pod-x/chart.png)\n2. Next\n"
    );
  });

  it("pastes a numbered list a file would not open as plain text", () => {
    const built = afterIntro();

    paste(built, { "text/plain": "1. one\n2. <div>two</div>\n" });

    expect(hasNumberedList(built)).toBe(false);
    expect(built.getText({ blockSeparator: "\n" })).toBe(
      "Intro\n1. one\n2. <div>two</div>\n"
    );
  });

  it("pastes a numbered list's comment anchors as text without extending a comment", () => {
    const built = openEditor(
      'Intro :comment-start{id=c1}noted:comment-end{id=c1}\n\n:::annotations\n::comment{id=c1 status=open}\n\n::message{author=user:usr_daph name="Daph" at=2026-09-25T14:16:32.380Z}\n\nWhy?\n:::\n'
    );
    caretAfter(built, "noted");
    press(built, "Enter");

    paste(built, {
      "text/plain": "1. :comment-start{id=c1}copied:comment-end{id=c1}\n",
    });

    expect(commentedTexts(built)).toEqual(["noted"]);
    expect(built.getText()).toContain("copied");
  });

  it.each([false, true])(
    "pastes a numbered list without comment marks, live: %s",
    (live) => {
      const built = afterIntro({ live });

      paste(built, {
        "text/plain": "1. :comment-start{id=c9}copied:comment-end{id=c9}\n",
      });

      expect(commentedTexts(built)).toEqual([]);
      expect(built.getText()).toContain("copied");
    }
  );

  it("pastes text numbered with letters as text", () => {
    const built = afterIntro();

    paste(built, { "text/plain": "a. one\nb. two" });

    expect(hasNumberedList(built)).toBe(false);
    expect(built.getText({ blockSeparator: "\n" })).toBe(
      "Intro\na. one\nb. two"
    );
  });

  it("numbers a pasted HTML list with decimals", () => {
    const built = afterIntro();

    paste(built, {
      "text/html": '<ol type="a"><li>one</li><li>two</li></ol>',
    });

    expect(markdown(built)).toBe("Intro\n\n1. one\n2. two");
  });
});
