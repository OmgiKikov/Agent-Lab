import { useState } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { SECTIONS } from "../../app/links";
import { api } from "../../lab/api";
import { useCriteria } from "../../lab/criteria";
import { defaultExport } from "../../lab/exports";
import { count, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { previousOf } from "../../lab/compare";
import { checkedIn } from "../../lab/problemReport";
import { codeSources } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { ExportPicker } from "../../product/ExportPicker";
import { Button, buttonClass } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { Segmented } from "../../ui/Segmented";
import { Sheet } from "../../ui/Sheet";
import { useToast } from "../../ui/toast";
import { useComparison } from "./Compare";

const SIZES = [100, 200, 300];

/** The export the accuracy check starts on: the one asked for while it is here, else its result's, else the newest. */
export function useAssessExport(asked?: string | null) {
  const { state } = useLabState();
  const [picked, setPicked] = useState<string | null>(null);
  const here = (id?: string | null) => !!id && !!state?.exports.some((e) => e.id === id && e.total > 0);
  const id = here(picked) ? picked : here(asked) ? asked! : defaultExport(state, "code");
  const line = state?.exports.find((e) => e.id === id) ?? null;
  return { exportId: id, line, setExport: setPicked };
}

/** A stopped check of Точность on this export; one stopped before exports were kept was of the newest. */
const stoppedOn = (state: LabState | null, exportId: string | null) => {
  const input = state?.paused?.discover?.input;
  return input && (input.exportId ?? state?.exports[0]?.id) === exportId ? input : undefined;
};

/**
 * How many conversations of the export the accuracy check takes: 100, 200 or all up to 300; a stopped check's number
 * on the same export, which the same start continues, else the last check's, while it fits. The service takes 5 to
 * 300 (backend/lab/api/checks.py, DiscoverCommand). `resumes`: the size chosen continues the stopped check.
 */
export function useSampleSize(exportId: string | null) {
  const { state } = useLabState();
  const total = state?.exports.find((e) => e.id === exportId)?.total ?? 0;
  const sizes = [...new Set([...SIZES.filter((n) => n < total), Math.min(total, 300)])].filter((n) => n > 0);
  const paused = stoppedOn(state, exportId);
  const stopped = paused?.count;
  const previous = stopped ?? state?.checks.code?.sampled;
  const [picked, setPicked] = useState<number | null>(null);
  const size =
    picked && sizes.includes(picked)
      ? picked
      : previous && sizes.includes(previous)
        ? previous
        : sizes.includes(100)
          ? 100
          : (sizes[sizes.length - 1] ?? 0);
  // The same start continues it: this size, and the same button (with the criteria extracted anew, or not).
  const resumes = stopped && size === stopped ? { replan: !!paused?.replan } : null;
  return { sizes, size, setSize: setPicked, resumes };
}

/** The stopped check the same start continues: said where its size is chosen, with the button that continues it. */
export function Resumes({ when }: { when: { replan: boolean } | null }) {
  if (!when) return null;
  return (
    <p className="text-body text-fg-3">
      {when.replan
        ? "Прошлое извлечение критериев остановлено, проверенное сохранено: «Извлечь критерии заново» с тем же размером продолжит с этого места."
        : "Прошлая проверка остановлена, проверенное сохранено: с тем же размером продолжим с этого места."}
    </p>
  );
}

/** The choice of how many conversations to take, when there is one. */
export function SizePicker({ sizes, size, onSize }: { sizes: number[]; size: number; onSize: (n: number) => void }) {
  if (sizes.length < 2) return null;
  return (
    <div>
      <Label>Сколько разговоров взять</Label>
      <div className="mt-2">
        <Segmented<string>
          label="Сколько разговоров"
          value={String(size)}
          onChange={(v) => onSize(Number(v))}
          options={sizes.map((n) => ({ value: String(n), label: String(n) }))}
        />
      </div>
    </div>
  );
}

/**
 * Starts the accuracy check: the model reads the real conversations against the criteria from the agent's code;
 * `replan` reads the criteria from the code anew first. After it the automatic check proposes which errors are serious
 * (`propose`, lab/severity). The agent itself is not run, tone of voice is not touched.
 */
export function useAssess(onStarted?: () => void) {
  const { refresh } = useLabState();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const start = (size: number, replan: boolean, exportId: string | null) => {
    setStarting(true);
    api("/api/discover", { count: Math.max(5, size), replan, propose: true, exportId })
      .then(() => {
        refresh();
        onStarted?.();
        toast.notify("Оценка началась");
      })
      .catch(toast.error)
      .finally(() => setStarting(false));
  };
  return { start, starting };
}

/**
 * «Проверить снова» of accuracy: by the same criteria, how many conversations and one button; or «Извлечь критерии
 * заново» when the agent has changed. Only this check's result is replaced. Its criteria come from the agent's code:
 * opened before the code was read (⌘K «Проверить точность»), it says to read the code first, and nothing starts. With
 * no criteria to keep — no result, and no previous check whose criteria a new export kept — the check extracts them:
 * the sheet says so, not «те же, что в прошлый раз».
 */
export function AssessSheet({
  open,
  onClose,
  exportId: asked,
}: {
  open: boolean;
  onClose: () => void;
  /** The export asked for (?export= of the address): from an export's page. */
  exportId?: string | null;
}) {
  const { state } = useLabState();
  const { data } = useCriteria("code");
  const previous = previousOf(useComparison("code"));
  // Without a result, criteria are kept only when the export of the last check was removed (checks.CODE_CRITERIA).
  const fresh = !!state && !state.checks.code && !previous;
  const { exportId, line, setExport } = useAssessExport(asked);
  const { sizes, size, setSize, resumes } = useSampleSize(exportId);
  const { start, starting } = useAssess(onClose);
  const criteria = data ? checkedIn(data, "log").length : 0;
  const total = line?.total ?? 0;
  const deck = state?.cards?.check === "code" && !!state.cards.cards.length;
  // The service checks only with the code read (backend/lab/flows/accuracy.py): without it, every start would fail.
  const code = codeSources(state).length > 0;
  const why = state?.job.running
    ? "Сейчас идёт другая задача"
    : !code
      ? "Сначала прочитайте код агента"
      : !total
        ? "Сначала выберите выгрузку"
        : undefined;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={fresh ? "Проверить точность" : "Проверить точность снова"}
      sub="Модель проверит разговоры выгрузки по критериям из кода агента. Сам агент не запускается."
    >
      <div className="space-y-6 px-5 py-5">
        {code ? (
          <p className="text-read text-fg-2">
            {line ? `В выгрузке «${line.name}» ${count(total, "разговор", "разговора", "разговоров")}. ` : ""}
            {fresh
              ? "Модель извлечёт критерии из кода агента и проверит по ним разговоры."
              : criteria
                ? `Критерии те же, их ${criteria}.`
                : "Критерии те же, что в прошлый раз."}
          </p>
        ) : (
          <div>
            <p className="text-read text-fg-2">
              Код агента ещё не прочитан, а критерии точности берутся из него дословно. Прочитайте код в «Агенте».
            </p>
            <Link to={SECTIONS.agent} className={cn("mt-3", buttonClass())}>
              Прочитать код
            </Link>
          </div>
        )}
        {code && (
          <div>
            <Label>Выгрузка</Label>
            <div className="mt-2">
              <ExportPicker value={exportId} onChange={setExport} disabled={starting} />
            </div>
          </div>
        )}
        <SizePicker sizes={sizes} size={size} onSize={setSize} />
        <Resumes when={resumes} />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            loading={starting}
            disabled={!!why || !size}
            title={why}
            onClick={() => start(size, false, exportId)}
          >
            Оценить {size} {plural(size, "разговор", "разговора", "разговоров")}
          </Button>
          {why && <span className="text-small text-fg-3">{why}</span>}
        </div>
        {/* A first check extracts the criteria anyway: nothing to extract «заново». */}
        <div className={cn("border-t border-line pt-5", fresh && "hidden")}>
          <p className="max-w-[56ch] text-body text-fg-2">
            Если у агента новые инструкции или инструменты, извлеките критерии заново. Счёт, ссылки на проблемы и ваши
            ответы начнутся с нуля{deck ? ", сценарии из точности сбросятся" : ""}. Итог tone of voice не изменится.
          </p>
          <Button
            className="mt-3"
            variant="ghost"
            disabled={!!why || !size || starting}
            onClick={() => start(size, true, exportId)}
          >
            Извлечь критерии заново
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
