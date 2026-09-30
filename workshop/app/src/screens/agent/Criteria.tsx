import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { RotateCcw } from "lucide-react";
import { api } from "../../lab/api";
import { plural } from "../../lab/format";
import { useProblems, type RuleEntry } from "../../lab/problems";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { LINKS } from "../../shell/links";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { Details, type Detail } from "../../ui/Details";
import { Label } from "../../ui/Label";
import { Modal } from "../../ui/Modal";
import { TwoCol } from "../../ui/TwoCol";
import { useToast } from "../../ui/toast";
import { SourceDrawer } from "../problems/SourceDrawer";

/** «Извлечь заново»: new criteria from the code; the old ones stop counting, so it asks first. */
export function Reextract({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const [starting, setStarting] = useState(false);
  const count = state?.discover?.sampled ?? 100;
  const start = async () => {
    setStarting(true);
    try {
      await api("/api/discover", { count, replan: true });
      onClose();
      await refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setStarting(false);
    }
  };
  return (
    <Modal
      open={open} onClose={onClose} title="Извлечь критерии заново"
      footer={<>
        <Button variant="ghost" onClick={onClose}>Отмена</Button>
        <Button variant="primary" onClick={start} loading={starting} disabled={!!state?.job.running}>Извлечь и оценить {count} {plural(count, "диалог", "диалога", "диалогов")}</Button>
      </>}
    >
      <p className="text-small text-lab-mute">
        Судья прочитает промпты и инструменты агента заново, извлечёт критерии и оценит по ним {count} {plural(count, "диалог", "диалога", "диалогов")} логов.
        Прежние критерии перестанут действовать: счёты, ссылки на нарушения и решения людей по вердиктам начнутся заново.
      </p>
      <p className="mt-3 text-small text-lab-mute">Нужно, когда агент поменялся: новый промпт, новые инструменты.</p>
    </Modal>
  );
}

const ALWAYS = "Всегда";
const SOURCE_NAME: Record<string, string> = { prompt: "Промпт ответа", tools: "Инструменты агента" };
const sourceName = (r: RuleEntry) => SOURCE_NAME[r.rule.kind] ?? (r.rule.origin.split("/").pop() || "Источник не указан");

/** «Когда спрашивают про …»: the topic, lowercased, cut to a short phrase. */
function situation(topic: string) {
  const t = topic.split(",")[0].trim();
  const short = t.length > 48 ? `${t.slice(0, 47).trimEnd()}…` : t;
  return `Когда спрашивают про ${short.charAt(0).toLowerCase()}${short.slice(1)}`;
}

type Group = { title: string; rules: { r: RuleEntry; also: string[] }[] };

/** Criteria by situation: no topic or three and more topics is «Всегда»; else under the first topic, the rest as «также». */
function groupRules(rules: RuleEntry[]): Group[] {
  const map = new Map<string, Group>();
  const put = (title: string, r: RuleEntry, also: string[]) => {
    const g = map.get(title) ?? { title, rules: [] };
    g.rules.push({ r, also });
    map.set(title, g);
  };
  map.set(ALWAYS, { title: ALWAYS, rules: [] });
  for (const r of rules) {
    if (r.topics.length === 0 || r.topics.length >= 3) put(ALWAYS, r, []);
    else put(situation(r.topics[0]), r, r.topics.slice(1).map(t => t.toLowerCase()));
  }
  const always = map.get(ALWAYS)!;
  map.delete(ALWAYS);
  return [...(always.rules.length ? [always] : []), ...map.values()];
}

function RuleGroups({ rules, selected, onOpen }: { rules: RuleEntry[]; selected?: string; onOpen: (id: string) => void }) {
  return (
    <div className="px-4 py-4">
      {groupRules(rules).map(g => (
        <section key={g.title} className="mb-5">
          <h2 className="px-2 text-meta font-medium text-lab-mute">{g.title}</h2>
          <ul className="mt-1.5">
            {g.rules.map(({ r, also }) => (
              <li key={r.id}>
                <button type="button" onClick={() => onOpen(r.id)} aria-current={r.id === selected || undefined}
                  className={`block w-full rounded px-2 py-2 text-left transition-colors hover:bg-white/[0.04] ${r.id === selected ? "bg-white/[0.07]" : ""}`}>
                  <span className="block text-read text-lab-ink">{r.rule.text}</span>
                  {r.rule.condition && <span className="mt-0.5 block text-meta text-lab-dim">когда: {r.rule.condition}</span>}
                  {also.length > 0 && <span className="mt-0.5 block text-meta text-lab-dim">также: {also.join(", ")}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** One criterion as a contract: when it applies, what is fine, where the prompt says it, and the prompt's own words. */
function RuleContract({ r }: { r: RuleEntry }) {
  const [sourceOpen, setSourceOpen] = useState(false);
  const rows: Detail[] = [
    ...(r.rule.condition ? [{ label: "Когда действует", value: r.rule.condition }] : []),
    ...(r.rule.acceptable ? [{ label: "Что не считается нарушением", value: r.rule.acceptable }] : []),
    { label: "Где в промпте", value: (
      <span title={r.rule.origin || undefined}>
        {sourceName(r)}
        {r.rule.sourceId && <> · <button type="button" onClick={() => setSourceOpen(true)} className="underline decoration-white/20 underline-offset-2 hover:text-lab-ink">открыть</button></>}
      </span>
    ) },
  ];
  return (
    <div className="max-w-[720px] px-6 py-5">
      <h1 className="text-title font-medium text-lab-ink">{r.rule.text}</h1>
      <Details title="Договор" rows={rows} className="mt-4 [&_dl>div]:grid-cols-[190px_minmax(0,1fr)]" />
      <section className="mt-6">
        <Label>Как написано в промпте</Label>
        <blockquote className="mt-2 border-l-2 border-white/25 pl-4 text-read text-lab-soft">«{r.rule.quote}»</blockquote>
      </section>
      <p className="mt-8 text-meta text-lab-dim">
        Как агент соблюдает это правило — в <Link to={`${LINKS.logs}?p=${r.id}`} className="underline decoration-white/20 underline-offset-2 hover:text-lab-text">«Логах»</Link> и <Link to={`${LINKS.results}?p=${r.id}`} className="underline decoration-white/20 underline-offset-2 hover:text-lab-text">«Результатах»</Link>
      </p>
      <SourceDrawer open={sourceOpen} onClose={() => setSourceOpen(false)} sourceId={r.rule.sourceId} origin={r.rule.origin} quote={r.rule.quote} />
    </div>
  );
}

/** Критерии: the contract, list by situation on the left, the selected rule on the right (?c= selects one). No results here. */
export function CriteriaPage() {
  const [params, setParams] = useSearchParams();
  const { state, offline } = useLabState();
  const { data } = useProblems(null);
  const [reextract, setReextract] = useState(false);
  const all = data?.rules ?? [];
  const id = params.get("c");
  const selected = id ? all.find(r => r.id === id) : undefined;
  const open = (next: string) => setParams(prev => { const n = new URLSearchParams(prev); n.set("c", next); return n; }, { replace: true });
  const step = (d: 1 | -1) => {
    const order = groupRules(all).flatMap(g => g.rules.map(x => x.r.id));
    if (!order.length) return;
    const at = id ? order.indexOf(id) : -1;
    open(order[Math.max(0, Math.min(order.length - 1, at + d))]);
  };
  useKeys({ KeyJ: () => step(1), KeyK: () => step(-1) });

  if (offline && !state) return <ServiceDown />;
  const busy = !!state?.job.running;
  let body;
  if (!state || (state.discover && !data)) body = <div className="p-6"><Skeleton className="h-7 w-96" /><Skeleton className="mt-8 h-[420px]" /></div>;
  else if (!state.discover || !data) body = <EmptyState drop title="Критериев пока нет" className="h-full">Появятся при первой проверке логов: судья достанет их из промптов агента.</EmptyState>;
  else body = (
    <TwoCol
      left={<div className="-mx-[18px] -mt-4"><RuleGroups rules={all} selected={selected?.id} onOpen={open} /></div>}
      right={selected ? <RuleContract key={selected.id} r={selected} />
        : <EmptyState title={id ? "Этого критерия нет в текущем списке" : "Выберите правило"} className="h-full">{id ? "Критерии могли извлечь заново." : "Справа появится, когда оно действует и где написано в промпте."}</EmptyState>}
    />
  );
  return (
    <div className="flex h-full flex-col">
      <SectionHeader
        crumbs={[{ label: "Агент", to: "/agent" }, { label: "Критерии" }]}
        meta={data ? `${data.rules.length} ${plural(data.rules.length, "правило", "правила", "правил")} из промптов агента` : undefined}
        actions={<Button icon={RotateCcw} onClick={() => setReextract(true)} disabled={busy || !state?.discover} title={busy ? "Сейчас идёт другая задача" : undefined}>Извлечь заново</Button>}
      />
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      <Reextract open={reextract} onClose={() => setReextract(false)} />
    </div>
  );
}
