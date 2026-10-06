import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api, upload } from "./api";
import { resultOf } from "./checks";
import type { Summary } from "./history";
import type { LogDialogue } from "./problems";
import type { Check, ExportLine, ExportRef, LabState } from "./types";

/** The latest saved check of a check made of an export; `current` when it is that check's result now. */
export type ExportCheck = { id: string; finishedAt: string; summary: Summary; current: boolean };
export type ExportWithChecks = ExportLine & { checks: Record<Check, ExportCheck | null> };
/** A conversation of an export in its list: what the customer wrote first, and how many messages it has. */
export type ExportRow = { id: string; first: string; turns: number };

const path = (id: string) => `/api/exports/${encodeURIComponent(id)}`;

/** Changes when an export comes, goes or is renamed: what is read of the exports is asked again by it. */
export const exportsStamp = (state: LabState | null) =>
  (state?.exports ?? []).map((e) => `${e.id}:${e.name}:${e.total}`).join("|");

/** Conversations in all the exports: whether there is anything to check at all. */
export const exportsTotal = (state: LabState | null) => (state?.exports ?? []).reduce((n, e) => n + e.total, 0);

/** The exports with the checks made of each (GET /api/exports), asked again when an export or a result changes. */
export function useExports(state: LabState | null) {
  const results = (["tone", "code"] as const).map((c) => resultOf(state, c)?.checkId ?? "").join("|");
  return useQuery({
    queryKey: ["exports", exportsStamp(state), results],
    queryFn: () => api<{ exports: ExportWithChecks[] }>("/api/exports").then((r) => r.exports),
    enabled: !!state,
  });
}

/**
 * The export a result or a saved check was made of, by the name it has now; the name it had, and `gone`, when it was
 * removed since. Nothing for a result that names none (an older service's).
 */
export function exportOf(state: LabState | null, ref: ExportRef | null | undefined) {
  if (!ref) return null;
  const live = state?.exports.find((e) => e.id === ref.id);
  return { id: ref.id, name: live?.name ?? ref.name, gone: !live, line: live ?? null };
}

/** «выгрузка «Сентябрь»» — and «(удалена)» when it is gone: how a result names what it was made of. */
export const exportWords = (made: ReturnType<typeof exportOf>) =>
  made ? `выгрузка «${made.name}»${made.gone ? " (удалена)" : ""}` : null;

/** The export a check starts on unless one is asked for: its current result's while it is here, else the newest. */
export function defaultExport(state: LabState | null, check: Check): string | null {
  const own = resultOf(state, check)?.export?.id;
  if (own && state?.exports.some((e) => e.id === own)) return own;
  return state?.exports.find((e) => e.total > 0)?.id ?? null;
}

/** A new export from the chat's file, under the name a person gave it (the file's when empty). */
export const uploadExport = (file: File, name: string) => upload<ExportLine>("/api/exports", file, { title: name });

export const renameExport = (id: string, name: string) => api<ExportLine>(`${path(id)}/rename`, { name });

export const deleteExport = (id: string) => api<{ removed: ExportLine; cleared: Check[] }>(`${path(id)}/delete`, {});

/** Conversations of an export shown at a time. */
export const EXPORT_PAGE = 50;

/**
 * An export's conversations in its order, a page at a time: each next page asks from where the loaded ones end, so
 * the list goes to the last of them whatever its size.
 */
export function useExportRows(id: string) {
  return useInfiniteQuery({
    queryKey: ["export-rows", id],
    queryFn: ({ pageParam }) =>
      api<{ total: number; items: ExportRow[] }>(`${path(id)}/conversations?offset=${pageParam}&limit=${EXPORT_PAGE}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, page) => n + page.items.length, 0);
      return last.items.length && loaded < last.total ? loaded : undefined;
    },
  });
}

/** One conversation of an export, as it was uploaded: no check's verdicts with it. */
export function useExportConversation(id: string, dialogueId: string | null) {
  return useQuery({
    queryKey: ["export-conversation", id, dialogueId],
    queryFn: () => api<LogDialogue>(`${path(id)}/conversations/${encodeURIComponent(dialogueId ?? "")}`),
    enabled: !!dialogueId,
    staleTime: Infinity,
  });
}
