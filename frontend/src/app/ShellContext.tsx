import { createContext, useContext } from "react";

/** What every screen can ask of the frame: open the search (⌘K). */
export type Shell = { openPalette: () => void };

export const ShellContext = createContext<Shell>({ openPalette: () => {} });
export const useShell = () => useContext(ShellContext);
