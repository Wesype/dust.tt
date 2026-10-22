import { BarHeader, Spinner } from "@dust-tt/sparkle";
import { usePlatform } from "@extension/shared/context/PlatformContext";
import { useMcpServer } from "@extension/shared/hooks/useMcpServer";
import { ErrorFallback } from "@extension/ui/components/ErrorFallback";
import { UserDropdownMenu } from "@extension/ui/components/navigation/UserDropdownMenu";
import type { ReactNode } from "react";
import { createContext, useContext, useMemo } from "react";

const ClientSideMCPServerContext = createContext<string[] | undefined>(
  undefined
);

export function useClientSideMCPServerIds(): string[] | undefined {
  return useContext(ClientSideMCPServerContext);
}

interface ExtensionClientSideMCPServerProviderProps {
  children: ReactNode;
}

/**
 * @cc [owner:philipperolet,label:product] required-tools-before-ui
 * When `platform.mcp.isRequired` is true, `children` MUST NOT render until the platform's
 * client-side MCP server has registered and its id is available. If registration fails, it MUST
 * render `ErrorFallback` instead of a spinner, with `UserDropdownMenu` so the user can still sign
 * out or switch workspace.
 */
export function ExtensionClientSideMCPServerProvider({
  children,
}: ExtensionClientSideMCPServerProviderProps) {
  const platform = usePlatform();
  const { serverId, hasFailed } = useMcpServer();

  const clientSideMCPServerIds = useMemo(
    () => (serverId ? [serverId] : undefined),
    [serverId]
  );

  if (platform.mcp?.isRequired && !serverId) {
    if (hasFailed) {
      // Registration also fails when the workspace can't use Dust (e.g. its plan ended): keep the
      // user menu so the user can still sign out or switch workspace.
      return (
        <div>
          <BarHeader title="" tooltip="" rightActions={<UserDropdownMenu />} />
          <ErrorFallback />
        </div>
      );
    }

    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  return (
    <ClientSideMCPServerContext.Provider value={clientSideMCPServerIds}>
      {children}
    </ClientSideMCPServerContext.Provider>
  );
}
