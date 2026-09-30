import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Check, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../../lab/api";
import { count, plural } from "../../lab/format";
import { DEFAULT_PERSONA } from "../../lab/look";
import { FROM_LOG, pickOf, type Pick } from "../../lab/runs";
import type { LabState } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { LINKS } from "../../shell/links";
import { Button } from "../../ui/Button";
import { Label } from "../../ui/Label";
import { Modal } from "../../ui/Modal";
import { Segmented } from "../../ui/Segmented";
import { useToast } from "../../ui/toast";

function Block({ label, children }: { label: string; children: ReactNode }) {
  return <div className="mt-5 first:mt-0"><Label className="mb-2">{label}</Label>{children}</div>;
}

/** «Сыграть»: which agent, which scenarios, which customer types and how many times; then the run starts. */
export function PlayDialog({ open, onClose, state, preset, onStarted }: {
  open: boolean; onClose: () => void; state: LabState; preset?: string[] | null; onStarted: () => void;
}) {
  const { refresh } = useLabState();
  const toast = useToast();
  const cards = useMemo(() => state.cards?.cards ?? [], [state.cards]);
  const firstReady = state.targets.find(t => t.ready)?.id ?? "";
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
    setTarget(t => (state.targets.some(x => x.id === t && x.ready) ? t : firstReady));
  }, [open, preset]); // eslint-disable-line react-hooks/exhaustive-deps

  const deck = pickOf(cards, pick, chosen);
  const total = deck.length * types.length * Number(repeats);
  const toggle = <T,>(list: Set<T>, v: T) => { const next = new Set(list); if (next.has(v)) next.delete(v); else next.add(v); return next; };
  const flip = (id: string) => setTypes(t => (t.includes(id) ? (t.length > 1 ? t.filter(x => x !== id) : t) : [...t, id]));
  const busy = state.job.running;
  const start = () => {
    setSending(true);
    api("/api/runs", { target, cardIds: pick === "all" ? null : deck.map(c => c.id), label: label.trim(), repeats: Number(repeats), personas: types })
      .then(() => refresh()).then(() => { onClose(); onStarted(); })
      .catch(toast.error).finally(() => setSending(false));
  };

  return (
    <Modal
      open={open} onClose={onClose} title="Сыграть сценарии"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" icon={Play} loading={sending} disabled={!target || !deck.length || busy} onClick={start} title={busy ? "Сейчас идёт другая задача" : undefined}>
          Сыграть {count(total, "диалог", "диалога", "диалогов")}
        </Button>
      </>}
    >
      <div className="max-h-[60vh] overflow-auto pr-1">
        <Block label="Агент">
          <div role="radiogroup" className="flex flex-col gap-1">
            {state.targets.map(t => (
              <button
                key={t.id} type="button" role="radio" aria-checked={t.id === target} disabled={!t.ready} onClick={() => setTarget(t.id)}
                className={cn(
                  "flex items-start gap-2.5 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent",
                  t.id === target ? "border-white/25 bg-lab-active" : "border-white/[0.08] hover:bg-lab-hover", !t.ready && "cursor-default opacity-60 hover:bg-transparent",
                )}
              >
                <span className={cn("mt-1 size-3 flex-shrink-0 rounded-full border", t.id === target ? "border-lab-ink bg-lab-ink" : "border-white/30")} />
                <span className="min-w-0 flex-1">
                  <span className="block text-small text-lab-ink">{t.name}</span>
                  <span className="block text-meta text-lab-dim">{t.note}</span>
                  {!t.ready && <span className="mt-0.5 block text-meta text-lab-warn">Не настроен · <Link to={LINKS.agent} onClick={onClose} className="underline underline-offset-4">Агент</Link></span>}
                </span>
              </button>
            ))}
          </div>
        </Block>
        <Block label="Сценарии">
          <Segmented<Pick> value={pick} onChange={setPick} options={[
            { value: "all", label: "Все", count: cards.length },
            { value: "errors", label: "Из ошибок", count: cards.filter(c => c.origin === FROM_LOG).length },
            { value: "chosen", label: "Выбранные", count: chosen.size },
          ]} />
          {pick === "chosen" && (
            <div className="mt-2 max-h-[200px] overflow-auto rounded-md border border-white/[0.08]">
              {cards.map(c => (
                <label key={c.id} className="flex cursor-pointer items-start gap-2.5 border-b border-white/[0.06] px-3 py-2 last:border-0 hover:bg-lab-hover">
                  <input type="checkbox" checked={chosen.has(c.id)} onChange={() => setChosen(s => toggle(s, c.id))} className="mt-0.5 accent-white" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-small text-lab-text">{c.name}</span>
                    <span className="block truncate text-meta text-lab-dim">{c.topic}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </Block>
        <Block label="Типы клиентов">
          <div className="flex flex-wrap gap-1.5">
            {state.personas.map(p => {
              const on = types.includes(p.id);
              return (
                <button
                  key={p.id} type="button" aria-pressed={on} onClick={() => flip(p.id)} title={p.note}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-meta transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-lab-accent",
                    on ? "border-white/25 bg-lab-active text-lab-ink" : "border-white/[0.08] text-lab-mute hover:text-lab-text",
                  )}
                >
                  {on && <Check className="size-3" />}{p.name}
                </button>
              );
            })}
          </div>
        </Block>
        <Block label="Повторы">
          <Segmented value={repeats} onChange={setRepeats} options={["1", "2", "3"].map(n => ({ value: n, label: n === "1" ? "Один раз" : `${n} раза` }))} />
          <p className="mt-1.5 text-meta text-lab-dim">Повтор показывает, одинаково ли агент ведёт себя в той же ситуации.</p>
        </Block>
        <Block label="Подпись">
          <input
            name="label" autoComplete="off" aria-label="Подпись прогона" value={label} onChange={e => setLabel(e.target.value)} placeholder="Необязательно: что проверяете этим прогоном"
            className="h-8 w-full rounded-md border border-white/[0.08] bg-transparent px-2.5 text-small text-lab-text outline-none placeholder:text-lab-faint focus:border-white/25"
          />
        </Block>
        <p className="mt-5 text-small text-lab-mute">
          {count(deck.length, "сценарий", "сценария", "сценариев")} × {types.length} {plural(types.length, "тип", "типа", "типов")} клиента
          {repeats !== "1" ? ` × ${repeats} раза` : ""} = <span className="text-lab-ink">{count(total, "диалог", "диалога", "диалогов")}</span>
        </p>
      </div>
    </Modal>
  );
}
