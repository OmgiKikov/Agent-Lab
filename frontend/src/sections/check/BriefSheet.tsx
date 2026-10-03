import { useEffect, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { shareBase } from "../../app/agent";
import { HISTORY_SHOWN } from "../../app/product";
import { useCriteria, type Criterion } from "../../lab/criteria";
import { download } from "../../lab/problemReport";
import { toneResult } from "../../lab/tone";
import { toneBrief } from "../../lab/toneReport";
import type { Discover, LabState } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Sheet } from "../../ui/Sheet";
import { BriefPreview } from "./BriefPreview";

/** The criteria of one tone-of-voice result, matched by their quote: the problems service holds every criterion. */
export const ownCriteria = (result: Discover, list: Criterion[]) => {
  const quotes = new Set(result.topics.flatMap((t) => t.rules.map((r) => r.quote)));
  return list.filter((c) => quotes.has(c.r.rule.quote));
};

/**
 * The brief of the current tone-of-voice result, or "" while it cannot be told yet: no result, or the problems service
 * still holds an older check than the one on screen.
 */
export function useToneBrief(state: LabState | null): string {
  const { data, list } = useCriteria(null);
  const result = toneResult(state);
  if (!state || !result || !data || data.log?.finishedAt !== result.finishedAt) return "";
  const report = { ...data, rules: ownCriteria(result, list).map((c) => c.r) };
  return toneBrief(report, result, shareBase(), { filename: state.logs.file ?? undefined, saved: HISTORY_SHOWN });
}

/**
 * «Отчёт для письма» of a tone-of-voice result: the same one from the result, «Обзор» and «Диалоги», with the screen's
 * number and words. It is read here, then copied or downloaded; reading it calls no model.
 */
export function BriefSheet({ open, onClose, brief }: { open: boolean; onClose: () => void; brief: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Sheet open={open} onClose={onClose} title="Отчёт для письма" width="lg">
      <div className="px-5 py-6 sm:px-7">
        <div className="mb-6 flex flex-wrap gap-3">
          <Button
            size="lg"
            icon={Download}
            disabled={!brief}
            onClick={() => download("otchet-tone-of-voice.md", brief)}
          >
            Скачать отчёт
          </Button>
          <Button
            size="lg"
            icon={copied ? Check : Copy}
            disabled={!brief}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(brief);
                setCopied(true);
                setCopyError(false);
              } catch {
                setCopyError(true);
              }
            }}
          >
            {copied ? "Скопировано" : "Скопировать"}
          </Button>
        </div>
        {copyError && (
          <p role="alert" className="mb-4 text-body text-bad">
            Не удалось скопировать. Скачайте отчёт или выделите текст.
          </p>
        )}
        <BriefPreview text={brief} />
      </div>
    </Sheet>
  );
}
