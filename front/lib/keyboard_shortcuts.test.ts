import { matchesKeyboardShortcut } from "@app/lib/keyboard_shortcuts";
import { describe, expect, it } from "vitest";

function keydown(key: string, init: KeyboardEventInit = {}) {
  return new KeyboardEvent("keydown", { key, ...init });
}

describe("matchesKeyboardShortcut", () => {
  it("treats Mod as either Cmd or Ctrl", () => {
    expect(
      matchesKeyboardShortcut(keydown("k", { metaKey: true }), "Mod+K")
    ).toBe(true);
    expect(
      matchesKeyboardShortcut(keydown("k", { ctrlKey: true }), "Mod+K")
    ).toBe(true);
    expect(matchesKeyboardShortcut(keydown("k"), "Mod+K")).toBe(false);
  });

  it("matches the uppercase key Shift produces", () => {
    expect(
      matchesKeyboardShortcut(
        keydown("B", { metaKey: true, shiftKey: true }),
        "Mod+Shift+B"
      )
    ).toBe(true);
  });

  it("rejects extra modifiers", () => {
    expect(
      matchesKeyboardShortcut(
        keydown("K", { metaKey: true, shiftKey: true }),
        "Mod+K"
      )
    ).toBe(false);
    expect(matchesKeyboardShortcut(keydown("c", { ctrlKey: true }), "C")).toBe(
      false
    );
  });
});
