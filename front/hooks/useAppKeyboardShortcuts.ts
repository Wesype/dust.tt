import { useCommandPalette } from "@app/components/command_palette/CommandPaletteContext";
import { useDesktopNavigation } from "@app/components/navigation/DesktopNavigationContext";
import {
  APP_KEYBOARD_SHORTCUTS,
  matchesKeyboardShortcut,
} from "@app/lib/keyboard_shortcuts";
import { useAppRouter } from "@app/lib/platform";
import { isEditableTarget } from "@app/lib/utils/dom";
import { getConversationRoute } from "@app/lib/utils/router";
import type { LightWorkspaceType } from "@app/types/user";
import { useEffect } from "react";

export function useAppKeyboardShortcuts(owner: LightWorkspaceType) {
  const { toggleNavigationBar } = useDesktopNavigation();
  const { open: openCommandPalette } = useCommandPalette();

  const router = useAppRouter();

  useEffect(() => {
    function openNewConversation() {
      void router.push(getConversationRoute(owner.sId), undefined, {
        shallow: true,
      });
    }

    function handleKeyboardShortcuts(event: KeyboardEvent) {
      // Bare "c" → new conversation (Linear/Gmail-style). Skip while typing.
      if (
        matchesKeyboardShortcut(
          event,
          APP_KEYBOARD_SHORTCUTS.newConversation
        ) &&
        !isEditableTarget(event.target)
      ) {
        event.preventDefault();
        openNewConversation();
        return;
      }

      // Mod+Shift+S is strikethrough in editors that enable it (documents,
      // comments); their keymap already called preventDefault, so let it win.
      if (
        matchesKeyboardShortcut(
          event,
          APP_KEYBOARD_SHORTCUTS.toggleNavigationBar
        ) &&
        !event.defaultPrevented
      ) {
        event.preventDefault();
        toggleNavigationBar();
        return;
      }

      if (
        matchesKeyboardShortcut(
          event,
          APP_KEYBOARD_SHORTCUTS.openCommandPalette
        )
      ) {
        event.preventDefault();
        openCommandPalette();
        return;
      }

      // Legacy Mod+/: match produced "/" so AZERTY (Shift+:) still works.
      // Not shown in the UI — browsers like Firefox may still steal this combo.
      if ((event.metaKey || event.ctrlKey) && event.key === "/") {
        event.preventDefault();
        openNewConversation();
      }
    }

    window.addEventListener("keydown", handleKeyboardShortcuts);
    return () => window.removeEventListener("keydown", handleKeyboardShortcuts);
  }, [owner.sId, router, toggleNavigationBar, openCommandPalette]);
}
