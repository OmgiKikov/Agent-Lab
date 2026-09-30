import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ArrowRight, ChevronDown, Database, FileText, RotateCcw } from "lucide-react";
import { api } from "../../lab/api";
import { day, plural, thousands } from "../../lab/format";
import { fileOf, firstSentence, useAgentParts, type Part } from "../../lab/agentParts";
import type { Criterion } from "../../lab/criteria";
import { useSource } from "../../lab/problems";
import { LINKS } from "../../shell/links";
import { useKeys } from "../../shell/keys";
import { useLabState } from "../../shell/LabProvider";
import { Button } from "../../ui/Button";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
import { Mark, MarkStack } from "../../ui/Mark";
import { MarkedText } from "../../ui/MarkedText";
import { Pill, Chips } from "../../ui/Pill";
import { Caption, Floating, PageTitle, Soft, Tile, TileGrid, WithFloating } from "../../ui/Tile";
import { useToast } from "../../ui/toast";
import { cn } from "@/lib/utils";
import { ConnectionDrawer, useConnectionMemory, wayOf, WAY_NAME } from "./Connection";

const READ_AT = "lab.agent.sourcesReadAt";
const readAt = () => { try { return localStorage.getItem(READ_AT); } catch { return null; } };
type Filter = "prompt" | "tool" | "rules";

const KindPill = ({ kind }: { kind: Part["kind"] }) => kind === "prompt" ? <Pill icon={FileText}>Промпт</Pill> : <Pill icon={Database}>Система банка</Pill>;

function PartTile({ x, on, onOpen }: { x: Part; on: boolean; onOpen: () => void }) {
  const { data } = useSource(x.source?.id);
  const f = x.source ? fileOf(x.source) : null;
  return (
    <Tile on={on} onClick={onOpen}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1"><KindPill kind={x.kind} /></div>
        <MarkStack ns={x.ns} />
      </div>
      <div className="mt-3 truncate font-mono text-[13px] text-lab-ink">
        {f ? <>{f.file.replace(/\.py$/, "")}<span className="text-lab-faint">{f.file.endsWith(".py") ? ".py" : ""}</span></> : x.tool?.name}
      </div>
      <p className="mt-1 line-clamp-2 text-[12px] leading-[18px] text-lab-dim">
        {x.kind === "prompt" ? (data ? firstSentence(data.content) : "…") : x.tool?.where.length ? `Вызывается в ${x.tool.where.join(", ")}` : x.tool?.env}
      </p>
      <div className="mt-auto flex items-center gap-2 pt-3 text-[11.5px] text-lab-dim">
        {x.source ? <>{thousands(x.source.chars)}{f?.line && <span className="text-lab-faint">· строка {f.line}</span>}</> : <span className="truncate font-mono text-[10.5px] text-lab-faint">{x.tool?.env}</span>}
      </div>
    </Tile>
  );
}

function PartPanel({ x, criteria, onClose }: { x: Part; criteria: Criterion[]; onClose: () => void }) {
  const navigate = useNavigate();
  const { data, isLoading } = useSource(x.source?.id);
  const mine = criteria.filter(c => x.ns.includes(c.n));
  const f = x.source ? fileOf(x.source) : null;
  const open = (id: string) => navigate(`${LINKS.criteria}?c=${encodeURIComponent(id)}`);
  return (
    <Floating onClose={onClose} head={<KindPill kind={x.kind} />}>
      <h2 className="break-all font-mono text-[16px] leading-[22px] text-lab-ink">{f ? f.file : x.tool?.name}</h2>
      <p className="mt-1 break-all font-mono text-[11px] text-lab-dim">{x.source ? x.source.origin : x.tool?.env}</p>
      <Caption className="mt-5">{mine.length ? `Критерии отсюда · ${mine.length}` : "Критериев отсюда нет"}</Caption>
      {mine.length > 0 && (
        <div className="mt-2 overflow-hidden rounded-[10px] border border-white/[0.08]">
          {mine.map(c => (
            <button key={c.r.id} type="button" onClick={() => open(c.r.id)} className="flex w-full items-center gap-2.5 border-b border-white/[0.06] bg-[rgb(35,35,35)] px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-[rgb(40,40,40)]">
              <Mark n={c.n} /><span className="min-w-0 flex-1 truncate text-[12.5px] text-lab-text">{c.name}</span><ArrowRight className="size-3 text-lab-faint" />
            </button>
          ))}
        </div>
      )}
      {x.tool && x.tool.where.length > 0 && (
        <>
          <Caption className="mt-5">Где вызывается</Caption>
          <div className="mt-2 flex flex-wrap gap-1.5">{x.tool.where.map(w => <Pill key={w} mono className="rounded-md">{w}</Pill>)}</div>
        </>
      )}
      {x.source && (
        <>
          <Caption className="mt-6">Текст промпта</Caption>
          <div className="mt-2 rounded-[12px] border border-white/[0.08] bg-[rgb(33,33,33)] px-4 py-3.5">
            {isLoading || !data ? <Skeleton className="h-64" /> : (
              <MarkedText text={data.content} marks={mine.map(c => ({ quote: c.r.rule.quote, n: c.n }))} onMark={n => { const c = mine.find(m => m.n === n); if (c) open(c.r.id); }} />
            )}
          </div>
        </>
      )}
    </Floating>
  );
}

/** Агент, вкладка «Агент»: what the agent is made of — its prompts and the bank systems — as cards; one opens over the grid. */
export function Parts({ criteria }: { criteria: Criterion[] }) {
  const { state, refresh } = useLabState();
  const toast = useToast();
  const memory = useConnectionMemory();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter | null>(null);
  const [connecting, setConnecting] = useState(params.get("connect") === "1");
  const [reading, setReading] = useState(false);
  const { parts, prompts, tools } = useAgentParts(criteria);
  const pid = params.get("p");
  const setPid = (id: string | null) => setParams(prev => { const n = new URLSearchParams(prev); if (id) n.set("p", id); else n.delete("p"); return n; }, { replace: true });
  const shown = parts.filter(x => !filter || (filter === "rules" ? x.ns.length > 0 : x.kind === filter));
  const at = shown.findIndex(x => x.id === pid);
  useKeys({ KeyJ: () => shown.length && setPid(shown[Math.min(shown.length - 1, at + 1)].id), KeyK: () => shown.length && setPid(shown[Math.max(0, at - 1)].id) });
  if (!state) return <div className="p-6"><Skeleton className="h-64" /></div>;

  const busy = !!state.job.running || reading;
  const read = () => {
    setReading(true);
    api("/api/sources", {}).then(() => { try { localStorage.setItem(READ_AT, new Date().toISOString()); } catch { /* the date is a nicety */ } return refresh(); }).catch(toast.error).finally(() => setReading(false));
  };
  const way = wayOf(state, memory.last?.target ?? memory.way);
  const checked = !!memory.last;
  const part = parts.find(x => x.id === pid) ?? null;
  const readDate = day(readAt());

  const actions = (
    <>
      <Soft onClick={() => setConnecting(true)} title={checked ? "Отвечал при последней проверке" : "Ещё не проверялся"}
        className={checked ? "border-lab-ok/30 bg-lab-ok/[0.08] text-lab-ok hover:border-lab-ok/50 hover:text-lab-ok" : undefined}>
        <span className={cn("size-1.5 rounded-full", checked ? "bg-lab-ok" : "bg-lab-dim")} />{way ? WAY_NAME[way] : "Не подключён"}<ChevronDown className="size-3.5 opacity-70" />
      </Soft>
      {state.sources.length > 0 && (
        <Soft onClick={read} disabled={busy || !state.settings.repo} title={state.settings.repo ? `Папка с кодом: ${state.settings.repo}${readDate ? ` · прочитан ${readDate}` : ""}` : "Сначала укажите папку с кодом в подключении"}>
          <RotateCcw className={cn("size-3.5", reading && "animate-spin")} />Прочитать код заново
        </Soft>
      )}
    </>
  );

  return (
    <>
      <WithFloating open={!!part} panel={part && <PartPanel key={part.id} x={part} criteria={criteria} onClose={() => setPid(null)} />}>
        <PageTitle title="Из чего он сделан" sub="промпты и системы банка, прочитанные из его кода" actions={actions} />
        {!state.sources.length ? (
          <EmptyState drop title="Код агента ещё не прочитан" className="mt-10 rounded-[14px] border border-dashed border-white/[0.12]"
            action={state.settings.repo
              ? <Button variant="primary" loading={reading} disabled={busy} onClick={read}>Прочитать код</Button>
              : <Button variant="primary" onClick={() => setConnecting(true)}>Указать папку с кодом</Button>}>
            Прочитаем, что агенту велено в промптах и в какие системы банка он ходит. Из этого возьмём критерии.
          </EmptyState>
        ) : (
          <>
            <Chips<Filter> className="mt-4" value={filter} onChange={setFilter} options={[
              { value: null, label: "Всё", count: parts.length },
              { value: "prompt", label: "Промпты", count: prompts.length, icon: FileText },
              { value: "tool", label: "Системы банка", count: tools.length, icon: Database },
              { value: "rules", label: "С критериями", count: parts.filter(x => x.ns.length).length, dot: "rgb(232,145,45)" },
            ]} />
            <div className="mt-5">
              <TileGrid>{shown.map(x => <PartTile key={x.id} x={x} on={x.id === pid} onOpen={() => setPid(x.id === pid ? null : x.id)} />)}</TileGrid>
            </div>
            <p className="mt-4 text-[11px] text-lab-faint">{prompts.length} {plural(prompts.length, "промпт", "промпта", "промптов")} и {tools.length} {plural(tools.length, "система", "системы", "систем")} банка · J и K листают</p>
          </>
        )}
      </WithFloating>
      <ConnectionDrawer open={connecting} onClose={() => setConnecting(false)} state={state} />
    </>
  );
}
