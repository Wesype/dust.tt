import type { ClientMessageOrigin } from "@app/types/assistant/conversation";
import { createContext, useContext } from "react";

export type ClientType = Extract<
  ClientMessageOrigin,
  "web" | "extension" | "excel_addin"
>;

const ClientTypeContext = createContext<ClientType>("web");

export function useClientType(): ClientType {
  return useContext(ClientTypeContext);
}

export const ClientTypeProvider = ClientTypeContext.Provider;
