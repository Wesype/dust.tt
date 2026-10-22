import { createContext, useContext } from "react";

const SidebarToggleSlotContext = createContext(false);

export const SidebarToggleSlotProvider = SidebarToggleSlotContext.Provider;

export function useHasSidebarToggleSlot() {
  return useContext(SidebarToggleSlotContext);
}
