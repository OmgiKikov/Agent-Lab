import { useState } from "react";
import { api } from "../../lab/api";
import { useCriteria } from "../../lab/criteria";
import { count, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { checkedIn } from "../../lab/problemReport";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { Segmented } from "../../ui/Segmented";
import { Sheet } from "../../ui/Sheet";
import { useToast } from "../../ui/toast";

const SIZES = [100, 200, 300];

/**
 * How many conversations of the export the accuracy check takes: 100, 200 or all up to 300; the last check's number
 * while it fits. The service takes 5 to 300 (backend/lab/api.py, DiscoverCommand).
 */
export function useSampleSize() {
  const { state } = useLabState();
  const total = state?.logs.total ?? 0;
  const sizes = [...new Set([...SIZES.filter((n) => n < total), Math.min(total, 300)])].filter((n) => n > 0);
  const previous = state?.checks.code?.sampled;
  const [picked, setPicked] = useState<number | null>(null);
  const size =
    picked && sizes.includes(picked)
      ? picked
      : previous && sizes.includes(previous)
        ? previous
        : sizes.includes(100)
          ? 100
          : (sizes[sizes.length - 1] ?? 0);
  return { sizes, size, setSize: setPicked };
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
  const start = (size: number, replan: boolean) => {
    setStarting(true);
    api("/api/discover", { count: Math.max(5, size), replan, propose: true })
      .then(() => {
        refresh();
        onStarted?.();
        toast.notify("Оценка началась: ход виден внизу навигации");
      })
      .catch(toast.error)
      .finally(() => setStarting(false));
  };
  return { start, starting };
}

/**
 * «Проверить снова» of accuracy: by the same criteria, how many conversations and one button; or «Извлечь критерии
 * заново» when the agent has changed. Only this check's result is replaced.
 */
export function AssessSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state } = useLabState();
  const { data } = useCriteria("code");
  const { sizes, size, setSize } = useSampleSize();
  const { start, starting } = useAssess(onClose);
  const criteria = data ? checkedIn(data, "log").length : 0;
  const total = state?.logs.total ?? 0;
  const deck = state?.cards?.check === "code" && !!state.cards.cards.length;
  const why = state?.job.running ? "Сейчас идёт другая задача" : !total ? "Сначала загрузите разговоры" : undefined;
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Проверить точность снова"
      sub="Модель читает настоящие разговоры и по каждому критерию из кода агента отмечает: ошибка, без ошибки или не ясно. Сам агент не запускается."
    >
      <div className="space-y-6 px-5 py-5">
        <p className="text-read text-fg-2">
          В выгрузке {count(total, "разговор", "разговора", "разговоров")}.{" "}
          {criteria
            ? `Критерии те же: ${count(criteria, "критерий", "критерия", "критериев")} из кода агента.`
            : "Критерии те же, что в прошлой оценке."}
        </p>
        <SizePicker sizes={sizes} size={size} onSize={setSize} />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            loading={starting}
            disabled={!!why || !size}
            title={why}
            onClick={() => start(size, false)}
          >
            Оценить {size} {plural(size, "разговор", "разговора", "разговоров")}
          </Button>
          {why && <span className="text-small text-fg-3">{why}</span>}
        </div>
        <div className="border-t border-line pt-5">
          <p className="max-w-[56ch] text-body text-fg-2">
            Агент поменялся: новый промпт, новые инструменты? Критерии можно извлечь из кода заново. Прежние перестанут
            действовать: счёт, ссылки на проблемы и ваши ответы начнутся заново
            {deck ? ", а сценарии, собранные из точности, сбросятся" : ""}. Итог tone of voice не изменится.
          </p>
          <Button
            className="mt-3"
            variant="ghost"
            disabled={!!why || !size || starting}
            onClick={() => start(size, true)}
          >
            Извлечь критерии заново
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
