import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { pct, plural } from "../format";
import { disputed, itemKey } from "../logic";
import type { Item, LabRun, LabState } from "../types";
import { Badge, Button, Eyebrow, PersonaTag } from "../ui";
import { Conversation } from "./Conversation";
import { useToast } from "../toast";

type Decision = "agree" | "disagree";
/** Below this many answers a percentage says nothing, so it is not shown. */
const MIN_CHECKED = 10;

/**
 * Calibrating the judge: a person goes through the verdicts one by one and says whether the judge is right.
 * Disputed verdicts (the second judge disagrees) come first, then failures, then passes; the unchecked before the checked.
 * The answers are the run's `review` (POST /api/review), so «judge is right in N%» is the service's own number.
 */
export function JudgeCheck({ run, state, onReview, onOpen }: {
  run: LabRun; state: LabState; onReview: (index: number, decision: Decision | null) => Promise<unknown>; onOpen: (item: Item) => void;
}) {
  const items = run.items ?? [];
  // Verdict changes rebuild eligibility; ordinary review refreshes keep the order and selection.
  const eligibility = items.map(i => `${i.conversationId ?? itemKey(i)}:${i.status}:${i.second?.status ?? ""}`).join("|");
  const queue = useMemo(() => {
    const rank = (i: Item) => (disputed(i) ? 0 : i.status === "FAIL" ? 1 : 2) + (i.review ? 10 : 0);
    return items.map((item, index) => ({ item, index, key: `${run.id}:${item.conversationId ?? itemKey(item)}` }))
      .filter(x => x.item.status === "PASS" || x.item.status === "FAIL")
      .sort((a, b) => rank(a.item) - rank(b.item) || a.index - b.index)
      .map(({ index, key }) => ({ index, key }));
  }, [run.id, eligibility]); // eslint-disable-line react-hooks/exhaustive-deps
  const [saving, setSaving] = useState(false);
  const { error } = useToast();
  const decisionOf = (index: number) => items[index]?.review ?? null;
  const [selectedKey, setSelectedKey] = useState(() => queue.find(x => !items[x.index]?.review)?.key ?? queue[0]?.key);
  const at = Math.max(0, queue.findIndex(x => x.key === selectedKey));
  const select = (position: number) => setSelectedKey(queue[position]?.key);

  const reviewed = queue.filter(x => decisionOf(x.index));
  const agree = reviewed.filter(x => decisionOf(x.index) === "agree").length;
  const done = queue.length > 0 && reviewed.length === queue.length;
  const index = queue[at]?.index;
  const item = items[index];

  const decide = (decision: Decision) => {
    if (saving || !item) return;
    const next = decisionOf(index) === decision ? null : decision;
    setSaving(true);
    onReview(index, next)
      .then(() => { if (next) setSelectedKey(current => current === selectedKey ? queue[Math.min(at + 1, queue.length - 1)]?.key : current); })
      .catch(error)
      .finally(() => setSaving(false));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) || el.isContentEditable)) return;
      if (e.code === "Digit1") decide("agree");
      else if (e.code === "Digit2") decide("disagree");
      else if (e.code === "ArrowRight") select(Math.min(at + 1, queue.length - 1));
      else if (e.code === "ArrowLeft") select(Math.max(at - 1, 0));
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (!queue.length) return <div className="flex h-full items-center justify-center text-[13px] text-lab-dim">В прогоне нет оценённых разговоров</div>;
  const share = reviewed.length >= MIN_CHECKED ? pct(agree, reviewed.length) : null;
  const decision = decisionOf(index);

  return (
    <div className="flex h-full flex-col">
      <div className="flex-shrink-0 border-b border-white/[0.06] px-6 py-4">
        <div className="mx-auto flex max-w-[880px] flex-wrap items-center gap-x-8 gap-y-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-[14px] font-medium text-lab-ink"><ShieldCheck className="size-4 text-lab-mute" />Прав ли судья?</div>
            <div className="mt-0.5 text-[11px] leading-snug text-lab-dim">
              Прочитайте разговор и вердикт. Сначала идут спорные, где второй судья не согласен, потом провалы. Первыми идут трудные случаи, поэтому цифра строже, чем на всех разговорах. Точности агента можно верить настолько, насколько прав судья.
            </div>
          </div>
          <div className="text-right">
            <div className="text-[22px] font-medium leading-none text-lab-ink" style={{ fontFamily: '"AlphaLyrae", sans-serif' }}>{share === null ? "—" : `${share}%`}</div>
            <div className="mt-1 text-[11px] text-lab-dim">
              {share === null ? `нужно ещё ${MIN_CHECKED - reviewed.length}: пока мало данных` : `судья прав · проверено ${reviewed.length} из ${queue.length}`}
            </div>
          </div>
        </div>
        <div className="mx-auto mt-3 flex max-w-[880px] gap-[2px]">
          {queue.map((entry, k) => {
            const d = decisionOf(entry.index);
            return (
              <button key={entry.key} onClick={() => select(k)} aria-label={`Разговор ${k + 1}`}
                className={cn("h-1.5 flex-1 rounded-full transition-colors", d === "agree" ? "bg-lab-mute" : d === "disagree" ? "bg-lab-bad" : "bg-white/[0.08] hover:bg-white/20", k === at && "ring-1 ring-white/70 ring-offset-1 ring-offset-black")} />
            );
          })}
        </div>
      </div>

      {done && (
        <div className="flex-shrink-0 border-b border-white/[0.06] bg-white/[0.02] px-6 py-2.5">
          <div className="mx-auto max-w-[880px] text-[12px] text-lab-soft">
            Проверены все {queue.length} {plural(queue.length, "вердикт", "вердикта", "вердиктов")}. Судья прав в {agree} из {queue.length}
            {share !== null && share < 80 ? ": это мало, точности агента пока верить рано. Посмотрите критерии, где судья ошибается." : "."}
          </div>
        </div>
      )}

      <div className="flex flex-shrink-0 items-center gap-3 border-b border-white/[0.06] px-6 py-2.5">
        <div className="mx-auto flex w-full max-w-[880px] flex-wrap items-center gap-3">
          <span className="font-mono text-[11px] text-lab-dim">{at + 1} / {queue.length}</span>
          <span className="text-[13px] font-medium text-lab-text">{item.name}</span>
          <PersonaTag personas={state.personas} id={item.persona} />
          {disputed(item) && <Badge hue="warn">судьи расходятся</Badge>}
          <button onClick={() => onOpen(item)} className="text-[11px] text-lab-dim hover:text-lab-text">открыть в прогоне</button>
        </div>
      </div>

      <div className="sb min-h-0 flex-1 overflow-auto">
        <Conversation key={queue[at].key} item={item} state={state} />
      </div>

      <div className="flex-shrink-0 border-t border-white/[0.08] bg-black/95 px-6 py-3">
        <div className="mx-auto flex max-w-[880px] items-center gap-2">
          <Button size="sm" variant="ghost" icon={ArrowLeft} disabled={at === 0} onClick={() => select(at - 1)}>Назад</Button>
          <Button size="sm" variant="ghost" onClick={() => select(Math.min(at + 1, queue.length - 1))} disabled={at >= queue.length - 1}>Пропустить<ArrowRight className="size-3" /></Button>
          <div className="flex flex-1 items-center justify-center gap-2 pr-16">
            <Eyebrow className="mr-2">вердикт «{item.status === "PASS" ? "пройден" : "провален"}» верный?</Eyebrow>
            <Button variant={decision === "agree" ? "primary" : "secondary"} icon={Check} disabled={saving} onClick={() => decide("agree")}>Верно <kbd className="ml-1 opacity-50">1</kbd></Button>
            <Button variant={decision === "disagree" ? "danger" : "secondary"} icon={X} disabled={saving} onClick={() => decide("disagree")} className={decision === "disagree" ? "ring-1 ring-lab-bad/60" : undefined}>Неверно <kbd className="ml-1 opacity-50">2</kbd></Button>
          </div>

        </div>
      </div>
    </div>
  );
}
