import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, Check, Clock, FileText, Globe, RotateCcw, Search, Sparkles } from "lucide-react";
import { api } from "../../lab/api";
import { fileOf } from "../../lab/agentParts";
import { EVERY, useQuoteContext, type Criterion, type Topic } from "../../lab/criteria";
import { plural } from "../../lab/format";
import { LINKS } from "../../shell/links";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { Button } from "../../ui/Button";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
import { Mark, MARK_TEXT } from "../../ui/Mark";
import { Modal } from "../../ui/Modal";
import { Chips, Pill } from "../../ui/Pill";
import { Caption, Floating, PageTitle, Soft, Stack, Tile, TileGrid, WithFloating } from "../../ui/Tile";
import { useToast } from "../../ui/toast";

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

/** Where a criterion applies, as pills: every conversation, or the topics with their colour. */
export function Scope({ c, max = 2 }: { c: Criterion; max?: number }) {
  if (c.every) return <Pill icon={Globe}>{EVERY}</Pill>;
  return (
    <>
      {c.topics.slice(0, max).map(t => <Pill key={t.topic} dot={t.hue} hue={t.hue} title={t.topic}>{t.short}</Pill>)}
      {c.topics.length > max && <Pill title={c.topics.slice(max).map(t => t.topic).join(", ")}>+{c.topics.length - max}</Pill>}
    </>
  );
}

function CriterionTile({ c, on, onOpen }: { c: Criterion; on: boolean; onOpen: () => void }) {
  return (
    <Tile on={on} onClick={onOpen}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5"><Scope c={c} /></div>
        <Mark n={c.n} on={on} />
      </div>
      <div className="mt-3 text-[14px] font-medium leading-[20px] text-lab-ink">{c.name}</div>
      <p className="mt-1 line-clamp-2 text-[12px] leading-[18px] text-lab-dim">{c.r.rule.text}</p>
      {c.r.rule.acceptable && (
        <div className="mt-auto flex items-start gap-2 pt-3 text-[11.5px]"><Check className="mt-[2px] size-3 flex-shrink-0 text-lab-ok" /><span className="line-clamp-1 text-lab-soft">{c.r.rule.acceptable}</span></div>
      )}
    </Tile>
  );
}

/** One criterion as a contract: what it asks, what is fine, when it is checked, and the prompt's own words. */
function CriterionPanel({ c, onClose }: { c: Criterion; onClose: () => void }) {
  const { parts, loading } = useQuoteContext(c.r, 220);
  const f = fileOf(c.r.rule);
  return (
    <Floating onClose={onClose} head={<><Mark n={c.n} on /><span className="text-[11px] text-lab-dim">Критерий {c.n}</span></>}>
      <div className="flex flex-wrap gap-1.5"><Scope c={c} max={7} /></div>
      <h2 className="mt-3 text-[20px] font-medium leading-[26px] tracking-[-0.4px] text-lab-ink">{c.name}</h2>
      <p className="mt-2 text-[13px] leading-[20px] text-lab-soft">{c.r.rule.text}</p>
      <div className="mt-4 grid grid-cols-2 gap-2">
        <div className="rounded-[8px] border border-white/[0.08] bg-[rgb(35,35,35)] p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-lab-ok"><Check className="size-3" />Так можно</div>
          <p className="mt-1 text-[12px] leading-[18px] text-lab-text">{c.r.rule.acceptable || "—"}</p>
        </div>
        <div className="rounded-[8px] border border-white/[0.08] bg-[rgb(35,35,35)] p-3">
          <div className="flex items-center gap-1.5 text-[11px] text-lab-mute"><Clock className="size-3" />Когда проверяем</div>
          <p className="mt-1 text-[12px] leading-[18px] text-lab-text">{c.r.rule.condition || EVERY}</p>
        </div>
      </div>
      <Caption className="mt-6">Как написано в промпте</Caption>
      <Stack depth={2} className="mb-5 mr-5 mt-2">
        <div className="rounded-[12px] border border-[rgba(232,145,45,0.28)] bg-[rgb(37,33,29)] px-4 py-3.5">
          <div className="flex items-center gap-2 text-[11px] text-lab-dim"><FileText className="size-3" /><span className="truncate font-mono text-lab-soft" title={c.r.rule.origin}>{c.r.rule.kind === "tools" ? "Инструменты агента" : f.file}</span></div>
          <div className="mt-2 whitespace-pre-line text-[12.5px] leading-[20px] text-lab-mute">
            {loading ? <Skeleton className="h-20" /> : parts
              ? <>{parts[0]}<mark className={MARK_TEXT}>{parts[1]}</mark><span className="ml-1 inline-block translate-y-[-1px] align-middle"><Mark n={c.n} on size={18} /></span>{parts[2]}</>
              : <>«{c.r.rule.quote}»<span className="mt-2 block text-[11px] text-lab-warn">Этой фразы нет в нынешнем тексте источника дословно: возможно, он поменялся.</span></>}
          </div>
          {c.r.rule.sourceId && c.r.rule.kind !== "tools" && (
            <Link to={`${LINKS.agent}?p=${encodeURIComponent(c.r.rule.sourceId)}`} className="mt-3 inline-flex items-center gap-1 text-[11px] text-lab-mute hover:text-lab-ink">
              Весь промпт<ArrowRight className="size-3" />
            </Link>
          )}
        </div>
      </Stack>
      <p className="text-[11px] leading-[16px] text-lab-faint">
        Как агент его соблюдает — в <Link to={`${LINKS.logs}?p=${c.r.id}`} className="underline decoration-white/20 underline-offset-2 hover:text-lab-text">логах</Link> и в <Link to={`${LINKS.results}?p=${c.r.id}`} className="underline decoration-white/20 underline-offset-2 hover:text-lab-text">результатах прогонов</Link>.
      </p>
    </Floating>
  );
}

/** Агент, вкладка «Критерии»: the contract as cards with the topics they apply to; one opens over the grid. No results here. */
export function Criteria({ criteria, topics, unnamed }: { criteria: Criterion[]; topics: Topic[]; unnamed: number }) {
  const { state, refresh } = useLabState();
  const navigate = useNavigate();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [reextract, setReextract] = useState(false);
  const [naming, setNaming] = useState(false);
  const cid = params.get("c");
  const setCid = (id: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (id) n.set("c", id); else n.delete("c"); return n; }, { replace: true });
  const q = query.trim().toLowerCase();
  const shown = criteria.filter(c => (!filter || (filter === EVERY ? c.every : !c.every && c.r.topics.includes(filter))) && (!q || `${c.name} ${c.r.rule.text}`.toLowerCase().includes(q)));
  const at = shown.findIndex(c => c.r.id === cid);
  useKeys({ KeyJ: () => shown.length && setCid(shown[Math.min(shown.length - 1, at + 1)].r.id), KeyK: () => shown.length && setCid(shown[Math.max(0, at - 1)].r.id) });
  if (!state) return <div className="p-6"><Skeleton className="h-64" /></div>;
  const busy = !!state.job.running;
  const chosen = criteria.find(c => c.r.id === cid) ?? null;
  const name = () => {
    setNaming(true);
    api("/api/names", {}).then(refresh).catch(toast.error).finally(() => setNaming(false));
  };

  return (
    <>
      <WithFloating open={!!chosen} panel={chosen && <CriterionPanel key={chosen.r.id} c={chosen} onClose={() => setCid(null)} />}>
        <PageTitle title="Критерии" sub="что агент обязан делать · фразы из его промптов" actions={criteria.length > 0 && (
          <>
            {unnamed > 0 && (
              <Soft onClick={name} disabled={busy || naming} title="Модель даст каждому критерию имя в 2–5 слов. Один запрос к модели.">
                <Sparkles className="size-3.5" />Дать короткие имена
              </Soft>
            )}
            <label className="flex h-8 w-[200px] items-center gap-2 rounded-lg border border-white/[0.1] bg-white/[0.03] px-2.5 focus-within:border-white/[0.22]">
              <Search className="size-3.5 text-lab-dim" />
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Найти критерий" className="min-w-0 flex-1 bg-transparent text-[12px] text-lab-ink outline-none placeholder:text-lab-faint" />
            </label>
            <Soft onClick={() => setReextract(true)} disabled={busy} title={busy ? "Сейчас идёт другая задача" : "Когда агент поменялся"}><RotateCcw className="size-3.5" />Извлечь заново</Soft>
          </>
        )} />
        {!criteria.length ? (
          state.discover
            ? <div className="mt-6"><Skeleton className="h-64" /></div>
            : (
              <EmptyState drop title="Критериев пока нет" className="mt-10 rounded-[14px] border border-dashed border-white/[0.12]"
                action={<Button variant="primary" onClick={() => navigate(LINKS.logs)}>Перейти к логам</Button>}>
                Появятся при первой оценке логов: судья возьмёт их из промптов агента дословно.
              </EmptyState>
            )
        ) : (
          <>
            <Chips<string> className="mt-4" value={filter} onChange={setFilter} options={[
              { value: null, label: "Все", count: criteria.length },
              { value: EVERY, label: EVERY, count: criteria.filter(c => c.every).length, icon: Globe },
              ...topics.map(t => ({ value: t.topic, label: t.short, title: t.topic, dot: t.hue, count: criteria.filter(c => !c.every && c.r.topics.includes(t.topic)).length })),
            ]} />
            <div className="mt-5">
              <TileGrid>{shown.map(c => <CriterionTile key={c.r.id} c={c} on={c.r.id === cid} onOpen={() => setCid(c.r.id === cid ? null : c.r.id)} />)}</TileGrid>
              {!shown.length && <p className="mt-10 text-center text-[13px] text-lab-dim">Ничего не нашлось</p>}
            </div>
            <p className="mt-4 text-[11px] text-lab-faint">{criteria.length} {plural(criteria.length, "критерий", "критерия", "критериев")} · номер у критерия один на весь продукт · J и K листают</p>
          </>
        )}
      </WithFloating>
      <Reextract open={reextract} onClose={() => setReextract(false)} />
    </>
  );
}
