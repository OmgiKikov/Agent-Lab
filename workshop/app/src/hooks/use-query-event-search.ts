import { useCallback, useEffect, useReducer, useRef } from "react";
import { listEvents, searchEvents, type QueryEvent, type SearchMode } from "../api/query-api";

const MAX_SEARCH_WINDOW_DAYS = 13;

interface DateWindow { gte: string; lt: string; }

interface SearchResultsState {
  results: QueryEvent[];
  cursor: string | null;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasSearched: boolean;
  windows: DateWindow[];
  windowIdx: number;
}

const initialSearchResultsState: SearchResultsState = {
  results: [],
  cursor: null,
  hasMore: false,
  loading: false,
  loadingMore: false,
  error: null,
  hasSearched: false,
  windows: [],
  windowIdx: 0,
};

type SearchResultsAction =
  | { type: "start"; append: boolean }
  | {
      type: "success";
      append: boolean;
      data: QueryEvent[];
      cursor: string | null;
      hasMore: boolean;
      windowIdx: number;
      windows?: DateWindow[];
    }
  | { type: "failure"; message: string };

function searchResultsReducer(state: SearchResultsState, action: SearchResultsAction): SearchResultsState {
  switch (action.type) {
    case "start":
      return {
        ...state,
        loading: !action.append,
        loadingMore: action.append,
        error: null,
        hasSearched: action.append ? state.hasSearched : true,
      };
    case "success":
      return {
        ...state,
        results: action.append ? [...state.results, ...action.data] : action.data,
        cursor: action.cursor,
        hasMore: action.hasMore,
        loading: false,
        loadingMore: false,
        windows: action.windows ?? state.windows,
        windowIdx: action.windowIdx,
      };
    case "failure":
      return {
        ...state,
        loading: false,
        loadingMore: false,
        error: action.message,
      };
  }
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}

function buildSearchWindows(totalDays: number): DateWindow[] {
  const windows: DateWindow[] = [];
  let endMs = Date.now();
  let remaining = totalDays;
  while (remaining > 0) {
    const chunk = Math.min(remaining, MAX_SEARCH_WINDOW_DAYS);
    const startMs = endMs - chunk * 86400000;
    windows.push({ gte: new Date(startMs).toISOString(), lt: new Date(endMs).toISOString() });
    remaining -= chunk;
    endMs = startMs;
  }
  return windows;
}

export function useQueryEventSearch({
  query,
  mode,
  dateRange,
  selectedSignal,
  enabled,
}: {
  query: string;
  mode: SearchMode;
  dateRange: string;
  selectedSignal: string;
  enabled: boolean;
}) {
  const [state, dispatchSearch] = useReducer(searchResultsReducer, initialSearchResultsState);
  const { cursor, windows, windowIdx } = state;
  const didInitialBrowse = useRef(false);

  const search = useCallback(async (opts: {
    append?: boolean;
    cursor?: string;
    windowIndex?: number;
    query?: string;
    mode?: SearchMode;
    dateRange?: string;
    signal?: string;
  } = {}) => {
    const isAppend = !!opts.append;
    dispatchSearch({ type: "start", append: isAppend });

    try {
      const searchQuery = opts.query ?? query;
      const searchMode = opts.mode ?? mode;
      const searchDateRange = opts.dateRange ?? dateRange;
      const signal = opts.signal ?? selectedSignal;
      const trimmed = searchQuery.trim();
      const totalDays = Number(searchDateRange);
      const activeWindows: DateWindow[] = isAppend ? windows : trimmed ? buildSearchWindows(totalDays) : [];
      const activeIdx = opts.windowIndex ?? (isAppend ? windowIdx : 0);
      const useWindow = activeWindows.length > 0;
      const w = useWindow ? activeWindows[activeIdx] : undefined;
      const fetchOpts = {
        cursor: opts.cursor,
        timestampGte: w?.gte ?? daysAgo(totalDays),
        timestampLt: w?.lt,
      };
      const res = trimmed
        ? await searchEvents({ query: trimmed, mode: searchMode, signal: signal || undefined, ...fetchOpts })
        : await listEvents({ signal: signal || undefined, ...fetchOpts });
      let nextCursor = res.meta.cursor;
      let nextHasMore = res.meta.has_more;
      let nextIdx = activeIdx;

      if (useWindow && !nextHasMore && activeIdx < activeWindows.length - 1) {
        nextIdx = activeIdx + 1;
        nextCursor = null;
        nextHasMore = true;
      }

      dispatchSearch({
        type: "success",
        append: isAppend,
        data: res.data,
        cursor: nextCursor,
        hasMore: nextHasMore,
        windowIdx: nextIdx,
        windows: isAppend ? undefined : activeWindows,
      });
    } catch (e: unknown) {
      dispatchSearch({ type: "failure", message: e instanceof Error ? e.message : "Search failed" });
    }
  }, [dateRange, mode, query, selectedSignal, windowIdx, windows]);

  const loadMore = useCallback(() => {
    if (cursor) {
      void search({ append: true, cursor });
    } else if (windowIdx < windows.length - 1) {
      void search({ append: true, windowIndex: windowIdx + 1 });
    }
  }, [cursor, search, windowIdx, windows]);

  useEffect(() => {
    if (didInitialBrowse.current) return;
    if (!enabled) return;
    didInitialBrowse.current = true;
    void search();
  }, [enabled, search]);

  return { ...state, search, loadMore };
}
