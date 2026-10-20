import {
  caretAfter,
  destroyOpenedEditors,
  markdown,
  openEditor,
  press,
  saved,
  stubRangeLayout,
  type,
} from "@app/components/editor/document/editor.test_utils";
import type { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(destroyOpenedEditors);

const checkboxes = (built: Editor) =>
  Array.from(
    built.view.dom.querySelectorAll<HTMLInputElement>("input[type=checkbox]")
  );

describe("task items", () => {
  stubRangeLayout();

  it("nests a task after a plain item with Tab, and lifts it back with Shift-Tab", () => {
    const built = openEditor("- plain\n- [ ] task\n- [x] done\n");
    caretAfter(built, "task");

    press(built, "Tab");
    expect(markdown(built)).toBe("- plain\n  - [ ] task\n- [x] done");

    press(built, "Tab", { shiftKey: true });
    expect(markdown(built)).toBe("- plain\n- [ ] task\n- [x] done");
  });

  it("starts an unticked task on Enter after a ticked one, and leaves the list on an empty one", () => {
    const built = openEditor("- [x] done\n- after\n");
    caretAfter(built, "done");

    press(built, "Enter");
    type(built, "next");
    expect(markdown(built)).toBe("- [x] done\n- [ ] next\n- after");

    press(built, "Enter");
    press(built, "Enter");
    const { $from } = built.state.selection;
    expect([$from.depth, $from.parent.type.name]).toEqual([1, "paragraph"]);
    expect(markdown(built)).toMatch(/^- \[x\] done\n- \[ \] next\n\n+- after$/);
  });

  it("saves a new empty task, written as an empty item until it has text", () => {
    const built = openEditor("- [x] done\n");
    caretAfter(built, "done");

    press(built, "Enter");
    expect(saved(built)).toBe("- [x] done\n- &nbsp;\n");

    type(built, "next");
    expect(saved(built)).toBe("- [x] done\n- [ ] next\n");
  });

  it("ticks a task on click, keeping focus in the text so the keyboard undoes it", async () => {
    const built = openEditor("- [ ] Milk\n- Notes\n");
    const [checkbox] = checkboxes(built);
    const mousedown = new MouseEvent("mousedown", {
      bubbles: true,
      cancelable: true,
    });

    checkbox.dispatchEvent(mousedown);
    checkbox.click();
    expect(mousedown.defaultPrevented).toBe(true);
    expect(markdown(built)).toBe("- [x] Milk\n- Notes");
    expect(checkboxes(built)[0].checked).toBe(true);

    await vi.waitFor(() => expect(document.activeElement).toBe(built.view.dom));
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
    );
    expect(markdown(built)).toBe("- [ ] Milk\n- Notes");
  });

  it("leaves the document and the checkbox unchanged when clicked read-only", () => {
    const built = openEditor("- [ ] Milk\n", { editable: false });
    const before = built.getJSON();
    const [checkbox] = checkboxes(built);

    checkbox.click();

    expect(built.getJSON()).toEqual(before);
    expect(checkbox.checked).toBe(false);
  });

  it("labels a checkbox with its item's text", () => {
    const built = openEditor("- [x] Milk\n");

    expect(checkboxes(built)[0].getAttribute("aria-label")).toBe("Milk");
  });

  it("names the checkbox of an empty task", () => {
    const built = openEditor("- [x] done\n");
    caretAfter(built, "done");

    press(built, "Enter");

    expect(checkboxes(built)[1].getAttribute("aria-label")).toBe("Task");
  });

  it("renders a plain list without checkboxes", () => {
    const built = openEditor("- a\n- b\n\n1. c\n");

    expect(checkboxes(built)).toEqual([]);
    expect(built.view.dom.querySelectorAll("li > p")).toHaveLength(3);
  });
});
