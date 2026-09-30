import { useState, type ReactNode } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../../lab/api";
import { day, plural } from "../../lab/format";
import { useProblems } from "../../lab/problems";
import { JobStrip } from "../../shell/Activity";
import { LINKS } from "../../shell/links";
import { useLabState } from "../../shell/LabProvider";
import { SectionHeader } from "../../shell/SectionHeader";
import { Button } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { useToast } from "../../ui/toast";
import { SourcesDrawer } from "./Code";
import { ConnectionDrawer, useConnectionMemory, wayOf, WAY_NAME } from "./Connection";
import { VariantA } from "./variants/VariantA";
import { VariantB } from "./variants/VariantB";
import { VariantC } from "./variants/VariantC";
import { CriteriaLooks } from "./variants/CriteriaLooks";
import { CriteriaStory } from "./variants/CriteriaStory";
import { VariantE } from "./variants/VariantE";
import { VariantF } from "./variants/VariantF";
import { VariantG } from "./variants/VariantG";

const READ_AT = "lab.agent.sourcesReadAt";
const readAt = () => { try { return localStorage.getItem(READ_AT); } catch { return null; } };

/** One step of the page: numbered and dashed while empty, a summary and a link once filled; the layout never changes. */
function Step({ n, title, done, muted, children, action }: { n: number; title: string; done: boolean; muted?: boolean; children: ReactNode; action: ReactNode }) {
  return done ? (
    <section className="rounded-xl border border-white/[0.08] px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-small text-lab-dim">{title}</div>
          {children}
        </div>
        <div className="flex-shrink-0 pt-0.5">{action}</div>
      </div>
    </section>
  ) : (
    <section className="rounded-xl border border-dashed border-white/[0.18] px-5 py-4">
      <div className={muted ? "opacity-60" : undefined}>
        <div className="flex items-center gap-2 text-small text-lab-text">
          <span className="flex size-5 items-center justify-center rounded-full border border-white/30 text-meta text-lab-ink">{n}</span>{title}
        </div>
        <div className="mt-2 text-small text-lab-mute">{children}</div>
      </div>
      <div className="mt-3">{action}</div>
    </section>
  );
}

const Link = ({ onClick, children }: { onClick: () => void; children: ReactNode }) => (
  <button type="button" onClick={onClick} className="text-small text-lab-ink hover:underline hover:decoration-white/40 hover:underline-offset-4">{children}</button>
);

/** Агент: one page that looks the same first time and later; the three cards only change their content. */
export function AgentPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { state, offline, refresh } = useLabState();
  const toast = useToast();
  const { data } = useProblems(null);
  const memory = useConnectionMemory();
  const [connecting, setConnecting] = useState(false);
  const [reading, setReading] = useState(false);
  const variant = params.get("v");
  if (variant === "a") return <VariantA />;
  if (variant === "b") return <VariantB />;
  if (variant === "c") return <VariantC />;
  if (variant === "d") return <CriteriaStory />;
  if (variant === "e") return <VariantE />;
  if (variant === "f") return <VariantF />;
  if (variant === "g") return <VariantG />;
  if (variant === "k1" || variant === "k2" || variant === "k3") return <CriteriaLooks look={variant} />;
  if (params.get("tab") === "criteria") return <Navigate to={`${LINKS.criteria}${params.get("c") ? `?c=${encodeURIComponent(params.get("c")!)}` : ""}`} replace />;
  if (params.get("tab") === "code" || params.get("tab") === "connection") {
    return <Navigate to={params.get("tab") === "code" ? "/agent?sources=1" : "/agent"} replace />;
  }
  if (offline && !state) return <ServiceDown />;
  const set = (edit: (n: URLSearchParams) => void) => setParams(prev => { const n = new URLSearchParams(prev); edit(n); return n; }, { replace: true });
  const sourcesOpen = params.get("sources") === "1";
  const setSources = (open: boolean) => set(n => { if (open) n.set("sources", "1"); else { n.delete("sources"); n.delete("source"); } });
  const busy = !!state?.job.running;
  const read = () => {
    setReading(true);
    api("/api/sources", {}).then(() => { try { localStorage.setItem(READ_AT, new Date().toISOString()); } catch { /* the date is a nicety */ } return refresh(); }).catch(toast.error).finally(() => setReading(false));
  };

  const sources = state?.sources ?? [];
  const prompts = sources.filter(s => s.kind === "prompt").length;
  const tools = sources.filter(s => s.kind === "tools").length;
  const connected = !!state && (!!state.settings.prodUrl || !!memory.last);
  const way = state ? wayOf(state, memory.last?.target ?? memory.way) : null;
  const rules = data?.rules.length ?? 0;
  const hasRules = !!state?.discover && rules > 0;
  const first = !connected ? 1 : !sources.length ? 2 : !hasRules ? 3 : 0;
  const readDate = day(readAt());

  return (
    <div className="flex h-full flex-col">
      <SectionHeader crumbs={[{ label: "Агент" }]} below={<JobStrip kinds={["sources"]} />} />
      <div className="min-h-0 flex-1 overflow-auto">
        {!state ? <div className="p-6"><Skeleton className="h-64" /></div> : (
          <div className="mx-auto max-w-[960px] px-6 pb-20 pt-8 lg:px-8">
            <div className="flex items-center gap-4">
              <div className="flex size-11 items-center justify-center rounded-[10px] bg-white/[0.08] text-heading font-medium text-lab-ink">А</div>
              <div>
                <h1 className="text-heading font-semibold text-lab-ink">Агент эквайринга</h1>
                <div className="text-small text-lab-dim">СберБизнес · чат поддержки</div>
              </div>
            </div>
            <div className="mt-8 space-y-3">
              <Step n={1} title="Подключение" done={connected} muted={first !== 1}
                action={connected ? <Link onClick={() => setConnecting(true)}>Изменить →</Link> : <Button variant={first === 1 ? "primary" : "outline"} onClick={() => setConnecting(true)}>Подключить агента</Button>}>
                {connected ? (
                  <>
                    <div className="mt-1 text-body text-lab-ink">{WAY_NAME[way ?? "prod"]}</div>
                    {memory.last && <div className="mt-1 truncate text-small text-lab-mute">Проверен {new Date(memory.last.at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}: «{memory.last.text}»</div>}
                  </>
                ) : "Где работает агент: тестовый стенд банка, этот компьютер или запуск из кода."}
              </Step>
              <Step n={2} title="Промпты и инструменты" done={sources.length > 0} muted={first !== 2}
                action={sources.length ? <Link onClick={() => setSources(true)}>Посмотреть →</Link>
                  : <Button variant={first === 2 ? "primary" : "outline"} loading={reading} disabled={busy || !state.settings.repo} onClick={read} title={!state.settings.repo ? "Сначала укажите папку с кодом в подключении" : busy ? "Сейчас идёт другая задача" : undefined}>Прочитать код</Button>}>
                {sources.length ? (
                  <>
                    <div className="mt-1 text-body text-lab-ink">
                      {prompts} {plural(prompts, "промпт", "промпта", "промптов")}{tools ? ` · ${tools} ${plural(tools, "набор инструментов", "набора инструментов", "наборов инструментов")}` : ""}
                    </div>
                    <div className="mt-1 text-small text-lab-mute">Прочитаны из кода агента{readDate ? ` ${readDate}` : ""}</div>
                  </>
                ) : "Прочитаем код агента: что ему велено и какие системы банка он вызывает."}
              </Step>
              <Step n={3} title="Критерии" done={hasRules} muted={first !== 3}
                action={hasRules ? <Link onClick={() => navigate(LINKS.criteria)}>Открыть список →</Link> : <Button variant={first === 3 ? "primary" : "outline"} onClick={() => navigate(LINKS.logs)}>Загрузить логи</Button>}>
                {hasRules ? (
                  <>
                    <div className="mt-1 text-body text-lab-ink">{rules} {plural(rules, "критерий", "критерия", "критериев")}</div>
                    <div className="mt-1 text-small text-lab-mute">Что агент обязан делать — правила из его промптов. По ним проверяем каждый диалог.</div>
                  </>
                ) : "Появятся при первой проверке логов: судья достанет их из промптов агента."}
              </Step>
            </div>
          </div>
        )}
      </div>
      {state && <ConnectionDrawer open={connecting} onClose={() => setConnecting(false)} state={state} />}
      {state && <SourcesDrawer open={sourcesOpen} onClose={() => setSources(false)} state={state} openId={params.get("source")} busy={busy || reading}
        onOpen={id => set(n => { if (id) n.set("source", id); else n.delete("source"); })} onReread={read} />}
    </div>
  );
}
