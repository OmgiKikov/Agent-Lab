import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../../lab/api";
import { count, plural } from "../../lab/format";
import { BY_CRITERIA } from "../../lab/checks";
import { DEFAULT_PERSONA } from "../../lab/look";
import { FROM_LOG, pickOf, type Pick } from "../../lab/runs";
import type { LabState } from "../../lab/types";
import { useLabState } from "../../lab/LabProvider";
import { SECTIONS } from "../../app/links";
import { Button } from "../../ui/Button";
import { Modal } from "../../ui/Modal";
import { Segmented } from "../../ui/Segmented";
import { useToast } from "../../ui/toast";

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mt-5 first:mt-0">
      <div className="mb-2 text-small font-medium text-fg-2">{label}</div>
      {children}
    </div>
  );
}

/** «Сыграть»: which agent, which scenarios, which customer types and how many times; then the run starts. */
export function PlayDialog({
  open,
  onClose,
  state,
  preset,
  presetTypes,
  onStarted,
}: {
  open: boolean;
  onClose: () => void;
  state: LabState;
  preset?: string[] | null;
  presetTypes?: string[] | null;
  onStarted: () => void;
}) {
  const { refresh } = useLabState();
  const toast = useToast();
  const cards = useMemo(() => state.cards?.cards ?? [], [state.cards]);
  const firstReady = state.targets.find((t) => t.ready)?.id ?? "";
  const [target, setTarget] = useState(firstReady);
  const [pick, setPick] = useState<Pick>("all");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [types, setTypes] = useState<string[]>([DEFAULT_PERSONA]);
  const [repeats, setRepeats] = useState("1");
  const [label, setLabel] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPick(preset?.length ? "chosen" : "all");
    setChosen(new Set(preset ?? []));
    const known = (presetTypes ?? []).filter((id) => state.personas.some((p) => p.id === id));
    if (known.length) setTypes(known);
    setTarget((t) => (state.targets.some((x) => x.id === t && x.ready) ? t : firstReady));
  }, [open, preset, presetTypes]); // eslint-disable-line react-hooks/exhaustive-deps

  const deck = pickOf(cards, pick, chosen);
  const total = deck.length * types.length * Number(repeats);
  const toggle = <T,>(list: Set<T>, v: T) => {
    const next = new Set(list);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };
  const flip = (id: string) =>
    setTypes((t) => (t.includes(id) ? (t.length > 1 ? t.filter((x) => x !== id) : t) : [...t, id]));
  const busy = state.job.running;
  const start = () => {
    setSending(true);
    api("/api/runs", {
      target,
      cardIds: pick === "all" ? null : deck.map((c) => c.id),
      label: label.trim(),
      repeats: Number(repeats),
      personas: types,
    })
      .then(() => refresh())
      .then(() => {
        onClose();
        onStarted();
      })
      .catch(toast.error)
      .finally(() => setSending(false));
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Сыграть сценарии"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button
            variant="primary"
            icon={Play}
            loading={sending}
            disabled={!target || !deck.length || busy}
            onClick={start}
            title={busy ? "Сейчас идёт другая задача" : undefined}
          >
            Сыграть {count(total, "разговор", "разговора", "разговоров")}
          </Button>
        </>
      }
    >
      <div className="max-h-[60vh] overflow-auto pr-1">
        <Block label="Агент">
          <div role="radiogroup" className="flex flex-col gap-1">
            {state.targets.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={t.id === target}
                disabled={!t.ready}
                onClick={() => setTarget(t.id)}
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
                  <span className="block text-small text-fg">{t.name}</span>
                  <span className="block text-small text-fg-3">{t.note}</span>
                  {!t.ready && (
                    <span className="mt-0.5 block text-small text-warn">
                      Не настроен ·{" "}
                      <Link to={SECTIONS.agent} onClick={onClose} className="underline underline-offset-4">
                        Агент
                      </Link>
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </Block>
        <Block label={state.cards ? `Сценарии ${BY_CRITERIA[state.cards.check]}` : "Сценарии"}>
          <Segmented<Pick>
            value={pick}
            onChange={setPick}
            options={[
              { value: "all", label: "Все", count: cards.length },
              { value: "errors", label: "Из ошибок", count: cards.filter((c) => c.origin === FROM_LOG).length },
              { value: "chosen", label: "Выбранные", count: chosen.size },
            ]}
          />
          {pick === "chosen" && (
            <div className="mt-2 max-h-[200px] overflow-auto rounded-control border border-line">
              {cards.map((c) => (
                <label
                  key={c.id}
                  className="flex cursor-pointer items-start gap-2.5 border-b border-line px-3 py-2 last:border-0 hover:bg-hover"
                >
                  <input
                    type="checkbox"
                    checked={chosen.has(c.id)}
                    onChange={() => setChosen((s) => toggle(s, c.id))}
                    className="mt-0.5 accent-white"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-small text-fg">{c.name}</span>
                    <span className="block truncate text-small text-fg-3">{c.topic}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </Block>
        <Block label="Типы клиентов">
          <div className="flex flex-wrap gap-1.5">
            {state.personas.map((p) => {
              const on = types.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => flip(p.id)}
                  title={p.note}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-control border px-2.5 text-small transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
                    on ? "border-fg-3 bg-selected text-fg" : "border-line text-fg-3 hover:text-fg",
                  )}
                >
                  {on && <Check className="size-3" />}
                  {p.name}
                </button>
              );
            })}
          </div>
        </Block>
        <Block label="Повторы">
          <Segmented
            value={repeats}
            onChange={setRepeats}
            options={["1", "2", "3"].map((n) => ({ value: n, label: n === "1" ? "Один раз" : `${n} раза` }))}
          />
          <p className="mt-1.5 text-small text-fg-3">
            Повтор показывает, одинаково ли агент ведёт себя в той же ситуации.
          </p>
        </Block>
        <Block label="Подпись">
          <input
            name="label"
            autoComplete="off"
            aria-label="Подпись прогона"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Необязательно: что проверяете этим прогоном"
            className="h-8 w-full rounded-control border border-line bg-transparent px-2.5 text-small text-fg outline-none placeholder:text-fg-4 focus:border-fg-3"
          />
        </Block>
        <p className="mt-5 text-small text-fg-3">
          {count(deck.length, "сценарий", "сценария", "сценариев")} × {types.length}{" "}
          {plural(types.length, "тип", "типа", "типов")} клиента
          {repeats !== "1" ? ` × ${repeats} раза` : ""} ={" "}
          <span className="text-fg">{count(total, "разговор", "разговора", "разговоров")}</span>
        </p>
      </div>
    </Modal>
  );
}
