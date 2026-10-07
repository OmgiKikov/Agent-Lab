import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { cn } from "@/lib/utils";
import { liveLink, SECTIONS } from "../../app/links";
import { resultOf } from "../../lab/checks";
import { exportOf, exportWords } from "../../lab/exports";
import { count, longDay, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { startReplay } from "../../lab/replays";
import type { Check } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { Segmented } from "../../ui/Segmented";
import { Sheet } from "../../ui/Sheet";
import { useToast } from "../../ui/toast";

const SIZES = [20, 50];
/** Conversations played at most in one check of the live agent (backend: domain/replay.py, LIMIT). */
const LIMIT = 100;

/**
 * «Проверить живого агента»: the customers of the check's result meet the agent again. Which agent (the ways set in
 * «Агент»), how many customers, and what happens to them: the real first message, then a synthetic customer who wants
 * the same; the same judge and criteria as the recordings.
 */
export function ReplaySheet({ check, open, onClose }: { check: Check; open: boolean; onClose: () => void }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const navigate = useNavigate();
  const result = resultOf(state, check);
  const targets = state?.targets ?? [];
  const firstReady = targets.find((t) => t.ready)?.id ?? "";
  const [picked, setPicked] = useState<string | null>(null);
  const target = picked && targets.some((t) => t.id === picked && t.ready) ? picked : firstReady;
  // The customers whose conversation the check judged: a verdict to set beside the one now.
  const judged = result?.summary.measured ?? 0;
  const sizes = [...new Set([...SIZES.filter((n) => n < judged), Math.min(judged, LIMIT)])].filter((n) => n > 0);
  const [chosen, setSize] = useState<number | null>(null);
  const size = chosen && sizes.includes(chosen) ? chosen : (sizes.find((n) => n >= 50) ?? sizes[sizes.length - 1] ?? 0);
  const [starting, setStarting] = useState(false);
  const running = !!state?.job.running;
  const made = exportOf(state, result?.export);
  const why = running
    ? "Сейчас идёт другая задача"
    : !result
      ? "Сначала проверьте записанные разговоры"
      : !target
        ? "Подключите агента в «Агенте»"
        : undefined;
  const start = () => {
    setStarting(true);
    startReplay(check, target, size)
      .then(() => refresh())
      .then(() => {
        onClose();
        void navigate(liveLink(check));
      })
      .catch(toast.error)
      .finally(() => setStarting(false));
  };
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Проверить живого агента"
      sub="Те же клиенты, тот же судья и те же критерии, что у записей."
    >
      <div className="space-y-6 px-5 py-5">
        <div className="space-y-2 text-read text-fg-2">
          <p>
            Возьмём клиентов из итога
            {made ? ` (${exportWords(made)}, проверено ${longDay(result?.finishedAt)})` : ""}. Синтетический клиент
            начнёт каждый разговор настоящей первой репликой и будет добиваться того же, что клиент в записи. Агент
            ответит столько раз, сколько тогда, но не больше трёх.
          </p>
          <p>
            Модель оценит тем же судьёй по тем же критериям и разговор сейчас, и запись на той же длине разговора.
            Каждый разговор встанет рядом со своей записью: стало лучше, стало хуже или без изменений.
          </p>
          <p className="text-body text-fg-3">
            Цифры и имена в выгрузке скрыты: первую реплику агент получит такой же, как в записи.
          </p>
        </div>
        <div>
          <Label>Агент</Label>
          <div role="radiogroup" aria-label="Агент" className="mt-2 flex flex-col gap-1">
            {targets.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={t.id === target}
                disabled={!t.ready}
                onClick={() => setPicked(t.id)}
                className={cn(
                  "flex items-start gap-2.5 rounded-control border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
                  t.id === target ? "border-fg-3 bg-selected" : "border-line hover:bg-hover",
                  !t.ready && "cursor-default opacity-60 hover:bg-transparent",
                )}
              >
                <span
                  className={cn(
                    "mt-1 size-3 flex-shrink-0 rounded-full border",
                    t.id === target ? "border-fg bg-fg" : "border-fg-4",
                  )}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-body text-fg">{t.name}</span>
                  <span className="block text-small text-fg-3">{t.note}</span>
                  {!t.ready && (
                    <span className="mt-0.5 block text-small text-warn">
                      Не настроен ·{" "}
                      <Link to={SECTIONS.agent} onClick={onClose} className="underline underline-offset-4">
                        Настроить
                      </Link>
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
        {sizes.length > 1 && (
          <div>
            <Label>Сколько клиентов</Label>
            <div className="mt-2">
              <Segmented<string>
                label="Сколько клиентов"
                value={String(size)}
                onChange={(v) => setSize(Number(v))}
                options={sizes.map((n) => ({ value: String(n), label: n === judged ? `Все, ${n}` : String(n) }))}
              />
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="primary" loading={starting} disabled={!!why || !size} title={why} onClick={start}>
            Проверить {size} {plural(size, "разговор", "разговора", "разговоров")}
          </Button>
          {why && <span className="text-small text-fg-3">{why}</span>}
        </div>
        {judged > 0 && (
          <p className="text-small text-fg-3">
            В итоге {count(judged, "проверенный разговор", "проверенных разговора", "проверенных разговоров")}: из них и
            берутся клиенты.
          </p>
        )}
      </div>
    </Sheet>
  );
}
