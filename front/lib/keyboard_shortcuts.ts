// App-wide keyboard shortcuts. "Mod" is Cmd on Mac and Ctrl elsewhere. Format
// them for display with useKeyboardShortcutLabel.
export const APP_KEYBOARD_SHORTCUTS = {
  newConversation: "C",
  openCommandPalette: "Mod+K",
  toggleNavigationBar: "Mod+Shift+S",
} as const;

// True when the event is exactly the shortcut: same key, same modifiers.
export function matchesKeyboardShortcut(
  event: KeyboardEvent,
  shortcut: string
): boolean {
  const parts = shortcut.split("+");
  const key = parts[parts.length - 1];
  const modifiers = new Set(parts.slice(0, -1));

  return (
    event.key.toLowerCase() === key.toLowerCase() &&
    (event.metaKey || event.ctrlKey) === modifiers.has("Mod") &&
    event.shiftKey === modifiers.has("Shift") &&
    event.altKey === modifiers.has("Alt")
  );
}
