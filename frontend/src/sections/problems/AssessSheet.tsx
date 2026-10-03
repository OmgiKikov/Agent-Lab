import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../../lab/api";
import { day, plural } from "../../lab/format";
import { SECTIONS } from "../../app/links";
import { useLabState } from "../../lab/LabProvider";
import { codeSources, toneResult } from "../../lab/tone";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { Segmented } from "../../ui/Segmented";
import { Sheet } from "../../ui/Sheet";
import { useToast } from "../../ui/toast";
import { UploadButton } from "../../product/UploadLogs";
import { HISTORY_SHOWN, TONE_ONLY } from "../../app/product";

const SIZES = [100, 200, 300];

/**
 * «Оценить диалоги» by the criteria from the agent's code, without leaving the problems: how many real conversations, by
 * how many criteria, how many to take, and one button. The agent itself is not run; the judge reads the dialogues.
 * Over a tone-of-voice result «again» means that check; the code is chosen on purpose (`code`, or from the sheet).
 */
export function AssessSheet({
  open,
  onClose,
  criteria,
  code = false,
}: {
  open: boolean;
  onClose: () => void;
  criteria: number;
  code?: boolean;
}) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const total = state?.logs.total ?? 0;
  const sizes = [...new Set([...SIZES.filter((n) => n < total), Math.min(total, 300)])].filter((n) => n > 0);
  const previous = state?.discover?.sampled;
  const [picked, setPicked] = useState<number | null>(null);
  const size =
    picked && sizes.includes(picked)
      ? picked
      : previous && sizes.includes(previous)
        ? previous
        : sizes.includes(100)
          ? 100
          : (sizes[sizes.length - 1] ?? 0);
  const [starting, setStarting] = useState(false);
  const [switched, setSwitched] = useState(false);
  const navigate = useNavigate();
  const busy = !!state?.job.running;
  const sources = codeSources(state).length;
  const tone = !!toneResult(state);
  const close = () => {
    setSwitched(false);
    onClose();
  };
  if (tone && !code && !switched)
    return (
      <Sheet
        open={open}
        onClose={close}
        title="Оценить диалоги заново"
        sub="Сейчас диалоги проверены по правилам общения — tone of voice."
      >
        <div className="space-y-5 px-5 py-5">
          <p className="max-w-[52ch] text-read text-fg-2">
            Эта проверка повторяется на своей странице: там её критерии и уточнения, которые вы подтвердили.
            {HISTORY_SHOWN && " Прошлые результаты остаются в истории."}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              size="lg"
              onClick={() => {
                close();
                void navigate("/check?step=criteria");
              }}
            >
              Повторить проверку tone of voice
            </Button>
            {/* The code assessment would take the place of this result, and tone-only screens never show it. */}
            {!TONE_ONLY && (
              <Button variant="ghost" size="lg" onClick={() => setSwitched(true)}>
                Оценить по коду агента
              </Button>
            )}
          </div>
        </div>
      </Sheet>
    );
  // Over a tone-of-voice result the criteria are read from the code anew: its frozen topic is not the agent's.
  const replan = tone;
  const shown = replan ? 0 : criteria;
  const start = () => {
    setStarting(true);
    api("/api/discover", { count: Math.max(5, size), replan })
      .then(() => {
        refresh();
        close();
        toast.notify("Оценка началась: ход виден внизу навигации");
      })
      .catch(toast.error)
      .finally(() => setStarting(false));
  };
  const why = busy
    ? "Сейчас идёт другая задача"
    : !sources
      ? "Сначала прочитайте код агента"
      : !total
        ? "Сначала загрузите диалоги"
        : undefined;
  return (
    <Sheet
      open={open}
      onClose={close}
      title="Оценить диалоги по коду агента"
      sub="Модель читает настоящие разговоры и по каждому критерию отмечает: ошибка, без ошибки или не ясно. Сам агент не запускается."
    >
      <div className="space-y-6 px-5 py-5">
        {replan && (
          <p className="rounded-control bg-inset px-4 py-3 text-body text-fg-2">
            Сейчас в «Диалогах» — проверка tone of voice. Оценка по коду агента займёт её место и сбросит собранные
            сценарии; проверки tone of voice и прогоны останутся.
          </p>
        )}
        <div className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-4">
          <div className="rounded-block border border-line p-4">
            <Label>Диалоги</Label>
            {total ? (
              <>
                <div className="mt-2 font-mono text-count text-fg">{total}</div>
                <div className="text-small text-fg-3">
                  {plural(total, "разговор", "разговора", "разговоров")}
                  {state?.logs.updatedAt ? `, выгрузка от ${day(state.logs.updatedAt)}` : ""}
                </div>
                <div className="mt-3">
                  <UploadButton variant="outline" label="Другая выгрузка" />
                </div>
              </>
            ) : (
              <div className="mt-3">
                <UploadButton label="Загрузить диалоги" />
              </div>
            )}
          </div>
          <span aria-hidden className="self-center text-title text-fg-4">
            ×
          </span>
          <div className="rounded-block border border-line p-4">
            <Label>Критерии</Label>
            {shown ? (
              <>
                <div className="mt-2 font-mono text-count text-fg">{shown}</div>
                <div className="text-small text-fg-3">из кода агента</div>
              </>
            ) : (
              <p className="mt-2 text-small text-fg-2">
                Они извлекаются дословно из промптов и инструментов при оценке.
              </p>
            )}
            {!sources && (
              <Link
                to={SECTIONS.agent}
                onClick={close}
                className="mt-3 inline-block text-small text-fg underline decoration-line-strong underline-offset-4"
              >
                Прочитать код агента
              </Link>
            )}
          </div>
        </div>
        {sizes.length > 1 && (
          <div>
            <Label>Сколько разговоров взять</Label>
            <div className="mt-2">
              <Segmented<string>
                label="Сколько разговоров"
                value={String(size)}
                onChange={(v) => setPicked(Number(v))}
                options={sizes.map((n) => ({ value: String(n), label: String(n) }))}
              />
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-5">
          <Button variant="primary" loading={starting} disabled={!!why || !size} title={why} onClick={start}>
            Оценить {size} {plural(size, "разговор", "разговора", "разговоров")}
            {shown ? ` по ${shown} ${plural(shown, "критерию", "критериям", "критериям")}` : ""}
          </Button>
          {why && <span className="text-small text-fg-3">{why}</span>}
        </div>
      </div>
    </Sheet>
  );
}
