import type { ReactNode } from "react";
import { Sheet } from "./Sheet";

/** The earlier name of the right-edge panel, kept for the screens not rebuilt yet. */
export function Drawer({ open, onClose, title, sub, children }: { open: boolean; onClose: () => void; title: ReactNode; sub?: ReactNode; children: ReactNode }) {
  return <Sheet open={open} onClose={onClose} title={title} sub={sub}>{children}</Sheet>;
}
