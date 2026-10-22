import { areExtensionMcpToolsAllowed } from "@app/lib/workspace_policies";
import { usePlatform } from "@extension/shared/context/PlatformContext";
import { useExtensionAuth } from "@extension/ui/components/auth/AuthProvider";
import { useEffect, useState } from "react";

/**
 * Registers the platform's workspace-scoped MCP server and returns its id, or whether
 * registration failed. Re-registers when the workspace changes.
 */
/**
 * @cc [owner:philipperolet,label:product] browser-tools-toggle-skips-required-tools
 * The workspace's `disableExtensionMcpTools` setting ("Browser extension tools") MUST stop the
 * platform's tools from registering when `platform.mcp.isRequired` is false, and MUST NOT stop
 * them from registering when it is true: it never turns off the Excel add-in's workbook tools.
 */
export function useMcpServer() {
  const platform = usePlatform();
  const [serverId, setServerId] = useState<string | undefined>(undefined);
  const [hasFailed, setHasFailed] = useState(false);

  const { workspace } = useExtensionAuth();
  const workspaceId = workspace?.sId;

  useEffect(() => {
    const mcp = platform.mcp;
    if (!mcp || !workspace) {
      return;
    }

    // The toggle is about the browser extension reading tabs, not about tools an app can't work
    // without.
    if (!mcp.isRequired && !areExtensionMcpToolsAllowed(workspace)) {
      return;
    }

    let isMounted = true;

    const setupServer = async () => {
      const result = await mcp.getOrCreateServer(workspace, (sid) => {
        if (isMounted) {
          setServerId(sid);
        }
      });

      if (!isMounted) {
        return;
      }

      // `getOrCreateServer` logs connection errors and returns no server.
      if (!result.server) {
        setHasFailed(true);
        return;
      }

      setServerId(result.serverId);
    };

    // Defer so that React StrictMode's synchronous mount→cleanup→mount cycle
    // cancels the first timer before it runs, preventing duplicate registrations.
    const timer = setTimeout(() => {
      void setupServer();
    }, 0);

    return () => {
      clearTimeout(timer);
      isMounted = false;
      void mcp.disconnect();
      setServerId(undefined);
      setHasFailed(false);
    };
    // workspace object excluded; workspaceId triggers re-runs.
  }, [platform.mcp, workspaceId]);

  return { serverId, hasFailed };
}
