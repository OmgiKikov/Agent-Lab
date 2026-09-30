import type { ReactNode } from "react";
import { Tiles, type Tile } from "./Tiles";

export type Stat = { label: string; value: ReactNode; of?: ReactNode; onClick?: () => void; active?: boolean; title?: string };

/** The block's summary over its list: the same stat tiles as an object's page, each a filter of the list. */
export function Summary({ stats, className }: { stats: Stat[]; className?: string }) {
  return <div className={className ?? "flex-shrink-0 px-4 pt-4"}><Tiles tiles={stats as Tile[]} /></div>;
}
