import { useQuery } from "@tanstack/react-query";
import { api } from "./api";
import type { Catalog, LabState } from "./types";

/**
 * The catalog of business scenarios the scenarios were placed by: fetched once per deck, and used only while it is the
 * catalog the deck names (a catalog built anew after the deck counts other placements). null before any catalog.
 */
export function useCatalog(state: LabState | null) {
  const revision = state?.cards?.catalogRevision ?? null;
  const query = useQuery({
    queryKey: ["catalog", revision],
    queryFn: () => api<Catalog>("/api/catalog").catch(() => null),
    enabled: !!revision,
    staleTime: Infinity,
  });
  return query.data && query.data.revision === revision ? query.data : null;
}
