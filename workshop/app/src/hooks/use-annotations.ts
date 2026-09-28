import { useCallback, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createAnnotation,
  deleteAnnotation,
  fromLab,
  listAnnotations,
  type Annotation,
  type AnnotationBroadcast,
  type AnnotationKind,
  type AnnotationSource,
} from "../api/annotations";
import { useWorkshopEvent } from "./use-workshop-ws";

export type { Annotation, AnnotationKind, AnnotationSource };

/**
 * Loads annotations for a run and keeps them live via the `annotation` WS
 * event. `freshIds` is the set of annotation ids that arrived via WS after
 * the initial load — the caller uses this to trigger the arrival animation
 * exactly once per annotation.
 */
export function useAnnotations(runId: string | null | undefined) {
  const [freshIds, setFreshIds] = useState<Set<string>>(() => new Set());
  const hydrated = useRef(false);
  const queryClient = useQueryClient();
  const queryKey = ["annotations", runId] as const;
  const annotationsQuery = useQuery({
    queryKey,
    queryFn: () => listAnnotations(runId!),
    enabled: !!runId,
    placeholderData: [] as Annotation[],
  });
  if (annotationsQuery.isSuccess) hydrated.current = true;

  // Live updates
  useWorkshopEvent("annotation", (data: AnnotationBroadcast) => {
    if (!data || data.run_id !== runId) return;
    if (data.op === "insert") {
      data = { ...data, annotation: fromLab(data.annotation) };
      queryClient.setQueryData<Annotation[]>(queryKey, (prev = []) =>
        prev.some((a) => a.id === data.annotation.id)
          ? prev
          : [...prev, data.annotation].sort((a, b) => a.created_at - b.created_at)
      );
      // Only agent annotations animate — user-authored ones appear
      // silently because the user just created them and doesn't need a CTA.
      if (hydrated.current && data.annotation.source !== "user") {
        setFreshIds((prev) => new Set(prev).add(data.annotation.id));
      }
    } else if (data.op === "delete") {
      queryClient.setQueryData<Annotation[]>(queryKey, (prev = []) => prev.filter((a) => a.id !== data.annotation.id));
      setFreshIds((prev) => {
        if (!prev.has(data.annotation.id)) return prev;
        const next = new Set(prev);
        next.delete(data.annotation.id);
        return next;
      });
    }
  });

  const clearFresh = useCallback((id: string) => {
    setFreshIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const createMutation = useMutation({
    mutationFn: (input: { span_id?: string | null; kind: AnnotationKind; note?: string; source?: AnnotationSource }) =>
      createAnnotation({ run_id: runId!, ...input }),
    onSuccess: (annotation) => {
      queryClient.setQueryData<Annotation[]>(queryKey, (prev = []) =>
        prev.some(a => a.id === annotation.id) ? prev : [...prev, annotation].sort((a, b) => a.created_at - b.created_at)
      );
    },
  });

  const removeMutation = useMutation({
    mutationFn: deleteAnnotation,
    onSuccess: (_result, id) => {
      queryClient.setQueryData<Annotation[]>(queryKey, (prev = []) => prev.filter(a => a.id !== id));
    },
  });

  const create = useCallback(async (input: { span_id?: string | null; kind: AnnotationKind; note?: string; source?: AnnotationSource }) => {
    if (!runId) return null;
    return createMutation.mutateAsync(input).catch(() => null);
  }, [createMutation, runId]);

  const remove = useCallback(async (id: string) => {
    await removeMutation.mutateAsync(id);
  }, [removeMutation]);

  return { annotations: annotationsQuery.data ?? [], freshIds, clearFresh, create, remove };
}
