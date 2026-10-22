import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";

// Also read by front-spa/index.html (static loading screen).
const NAVIGATION_BAR_COLLAPSED_STORAGE_KEY = "navigationBarCollapsed";

function readNavigationBarCollapsed(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return (
      localStorage.getItem(NAVIGATION_BAR_COLLAPSED_STORAGE_KEY) === "true"
    );
  } catch {
    return false;
  }
}

function writeNavigationBarCollapsed(collapsed: boolean) {
  try {
    localStorage.setItem(
      NAVIGATION_BAR_COLLAPSED_STORAGE_KEY,
      collapsed ? "true" : "false"
    );
  } catch {
    // localStorage may be full or unavailable — silently ignore.
  }
}

/**
 * @cc navigation-bar-preference label:react;product
 * `setNavigationBarPreference` and `toggleNavigationBar` are for user-initiated
 * changes and persist the choice in localStorage, restored on next load.
 * `setIsNavigationBarOpen` is for temporary programmatic changes (e.g. full
 * screen panels) and MUST NOT persist, so they never override the user's choice.
 * The storage key is also read by the static loading screen in front-spa/index.html
 * to render the collapsed layout before React mounts; keep both in sync.
 */
interface DesktopNavigationContextType {
  isNavigationBarOpen: boolean;
  toggleNavigationBar: () => void;
  setIsNavigationBarOpen: (open: boolean) => void;
  setNavigationBarPreference: (open: boolean) => void;
}

const DesktopNavigationContext =
  createContext<DesktopNavigationContextType | null>(null);

interface DesktopNavigationProviderProps {
  children: ReactNode;
  defaultOpen?: boolean;
}

export function NoOpDesktopNavigationProvider({
  children,
}: DesktopNavigationProviderProps) {
  const value = useMemo(
    () => ({
      setIsNavigationBarOpen: () => {},
      setNavigationBarPreference: () => {},
      toggleNavigationBar: () => {},
      isNavigationBarOpen: false,
    }),
    []
  );

  return (
    <DesktopNavigationContext.Provider value={value}>
      {children}
    </DesktopNavigationContext.Provider>
  );
}

export function DesktopNavigationProvider({
  children,
  defaultOpen = true,
}: DesktopNavigationProviderProps) {
  const [isNavigationBarOpen, setIsNavigationBarOpen] = useState(
    () => defaultOpen && !readNavigationBarCollapsed()
  );

  const setNavigationBarPreference = useCallback((open: boolean) => {
    setIsNavigationBarOpen(open);
    writeNavigationBarCollapsed(!open);
  }, []);

  const toggleNavigationBar = useCallback(() => {
    setNavigationBarPreference(!isNavigationBarOpen);
  }, [isNavigationBarOpen, setNavigationBarPreference]);

  const value = useMemo(
    () => ({
      setIsNavigationBarOpen,
      setNavigationBarPreference,
      toggleNavigationBar,
      isNavigationBarOpen,
    }),
    [setNavigationBarPreference, toggleNavigationBar, isNavigationBarOpen]
  );

  return (
    <DesktopNavigationContext.Provider value={value}>
      {children}
    </DesktopNavigationContext.Provider>
  );
}

export function useDesktopNavigation() {
  const context = useContext(DesktopNavigationContext);
  if (!context) {
    throw new Error(
      "useDesktopNavigation must be used within a DesktopNavigationProvider"
    );
  }
  return context;
}
