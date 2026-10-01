import { createContext, useContext } from "react";

/** Opens the assistant (components/MessagePane.tsx listens for it). */
export const ASK_EVENT = "raindrop:ask";

export type Shell = { openPalette: () => void; openAsk: (runId?: string | null) => void };

export const ShellContext = createContext<Shell>({ openPalette: () => {}, openAsk: () => {} });
export const useShell = () => useContext(ShellContext);
