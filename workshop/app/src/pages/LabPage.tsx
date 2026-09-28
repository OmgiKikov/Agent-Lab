/**
 * Agent Lab inside Raindrop Workshop.
 *
 * agent -> logs audit -> test cards -> synthetic customer runs -> one accuracy number.
 * Data and jobs live in the Agent Lab service (lab/api.py, :5901);
 * every conversation is a native Workshop trace, shown here with RunDetail.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import NumberFlow from "@number-flow/react";
import { ArrowLeft, Bot, ChevronRight, FileText, FlaskConical, Gauge, MessagesSquare, Play, RotateCcw, Upload } from "lucide-react";
import { RunDetail } from "../components/RunDetail";
import { C } from "../utils/colors";

const API = (() => {
  try { return localStorage.getItem("lab.api") || "http://127.0.0.1:5901"; } catch { return "http://127.0.0.1:5901"; }
})();

type Status = "PASS" | "FAIL" | "UNMEASURED" | "UNKNOWN" | "NOT_APPLICABLE" | "RUNNING";
type Rule = { ruleId: string; rule: string; status: Status; reason: string; agentQuote: string; title?: string };
type Metric = { accuracy: number | null; passed: number; failed: number; unmeasured: number; measured: number; total: number;
  secondJudge?: { model: string; checked: number; agree: number }; repeats?: { scenarios: number; stable: number; attempts: number };
  human?: { reviewed: number; agree: number };
  personas?: Record<string, { accuracy: number | null; passed: number; measured: number }> };
type Message = { role: "customer" | "agent"; text: string; fromLog?: boolean; ok?: boolean; status?: string; seconds?: number };
type Item = { cardId: string; name: string; topic: string; origin: string; status: Status; stage: string; conversation: Message[]; rules: Rule[]; error: string | null; runId?: string;
  attempt?: number; persona?: string; second?: { model: string; status: string; rules?: Rule[] }; review?: "agree" | "disagree" | null; world?: boolean };
type LabRun = { id: string; target: string; targetName: string; version: string; startedAt: string; finishedAt: string | null; status: string; metric: Metric | null; error: string | null; repeats?: number; items?: Item[] };
type Criterion = { id: string; text: string; quote: string; condition?: string; acceptable?: string };
type World = { organization: { name: string; inn: string; merchantName: string; address: string }; terminals: { nameForClient: string; terminalId: string; stateCode: string }[]; tools: Record<string, unknown> };
type Card = { id: string; topic: string; name: string; situation: string; opening: string; criteria: Criterion[]; origin: string; sourceDialogueId: string; world?: World | null; openings?: Record<string, string> };
type LogResult = { dialogueId: string; topicId: string; status: Status; rules: Rule[]; opening: string; runId?: string };
type Pattern = { rule: string; quote: string; topics: string[]; count: number; titles: string[]; examples: { dialogueId: string; reason: string; agentQuote: string; opening: string; url?: string }[] };
type Target = { id: string; name: string; kind: string; note: string; where: string; ready: boolean };
type Persona = { id: string; name: string; note: string };
type Settings = { prodUrl: string; epk: string[]; repo: string };
type Source = { id: string; kind: string; origin: string; chars: number; rules: number };
type Models = { via: string; main: string | null; second: string | null };
type Check = { ok: boolean; error?: string; status?: string; text?: string; seconds?: number; version?: string };
type LabState = {
  job: { kind: string | null; running: boolean; error: string | null; progress: { message?: string; done?: number; total?: number; run?: string } };
  model: string;
  models: Models;
  settings: Settings;
  sources: Source[];
  logs: { total: number };
  discover: null | { sampled: number; model: string; finishedAt: string; rulesSince?: string;
    topics: { id: string; title: string; rules: Criterion[] }[]; results: LogResult[];
    summary: { checked: number; failed: number; passed: number; unmeasured: number; patterns: Pattern[]; secondJudge?: { model: string; checked: number; agree: number } | null } };
  cards: null | { cards: Card[] };
  runs: LabRun[];
  targets: Target[];
  personas: Persona[];
};
type Step = "agent" | "logs" | "cards" | "run" | "accuracy";

const STEPS: Step[] = ["agent", "logs", "cards", "run", "accuracy"];
const STATUS_TEXT: Record<Status, string> = { PASS: "пройден", FAIL: "не пройден", UNMEASURED: "не измерено", UNKNOWN: "нет данных", NOT_APPLICABLE: "не применимо", RUNNING: "идёт" };
const RULE_TEXT: Record<string, string> = { PASS: "выполнено", FAIL: "нарушено", UNKNOWN: "нет данных", NOT_APPLICABLE: "не применимо" };
const LOG_TEXT: Record<string, string> = { PASS: "без нарушений", FAIL: "нарушение", UNMEASURED: "нет данных" };
const tone = (s: Status | string) => s === "PASS" ? C.green : s === "FAIL" ? "#F26B6B" : s === "RUNNING" ? C.accent : s === "NOT_APPLICABLE" ? C.fg0 : C.orange;
const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};
const when = (iso?: string | null) => iso ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "";
const titleFont = { fontFamily: '"AlphaLyrae", sans-serif' };
const DEFAULT_PERSONA = "default";
/** How a conversation of a run is addressed in the URL: its Workshop trace, or its place in the run when it has none. */
const itemKey = (i: Item) => i.runId ?? `${i.cardId}~${i.persona ?? DEFAULT_PERSONA}~${i.attempt ?? 1}`;
const personaName = (state: LabState, id?: string) => state.personas.find(p => p.id === (id ?? DEFAULT_PERSONA))?.name ?? id ?? "";
function PersonaTag({ state, id }: { state: LabState; id?: string }) {
  return <span className="text-[10px] font-mono px-1.5 py-px rounded whitespace-nowrap" style={{ color: C.fg2, background: "rgba(255,255,255,0.07)" }}>{personaName(state, id)}</span>;
}

/** One option of a choice: agent, customer type, repeats. */
function Choice({ on, onClick, title, children }: { on: boolean; onClick: () => void; title?: string; children: React.ReactNode }) {
  return (
    <button onClick={onClick} title={title} className="text-[12px] px-3 py-1.5 rounded-md transition-colors"
      style={{ color: on ? C.fg5 : C.fg2, background: on ? "rgba(255,255,255,0.12)" : "transparent", border: `1px solid ${on ? "rgba(255,255,255,0.24)" : C.border}` }}>
      {children}
    </button>
  );
}

function SettingRow({ label, first, children }: { label: string; first?: boolean; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] gap-4 items-start px-4 py-3" style={{ borderTop: first ? undefined : `1px solid ${C.border}` }}>
      <span className="text-[10px] font-mono uppercase tracking-wider pt-2" style={{ color: C.fg0 }}>{label}</span>
      <div>{children}</div>
    </div>
  );
}

const itemTitle = (i: Item, state: LabState) => i.name
  + (i.persona && i.persona !== DEFAULT_PERSONA ? ` · ${personaName(state, i.persona)}` : "")
  + (i.attempt && i.attempt > 1 ? ` · повтор ${i.attempt}` : "");
const disputed = (i: Item) => !!i.second && ["PASS", "FAIL", "UNMEASURED"].includes(i.second.status) && i.second.status !== i.status;

async function api<T>(path: string, body?: unknown): Promise<T> {
  const init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  return read<T>(await fetch(API + path, init));
}

async function upload<T>(path: string, file: File): Promise<T> {
  return read<T>(await fetch(`${API}${path}?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file }));
}

async function read<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((data as { detail?: string }).detail || `HTTP ${response.status}`);
  return data as T;
}

/* ---------- small building blocks in Workshop's visual language ---------- */

function Dot({ status, pulse }: { status: Status | string; pulse?: boolean }) {
  return <div className={`size-2 rounded-full flex-shrink-0 ${pulse ? "pulse-dot" : ""}`} style={{ background: tone(status) }} />;
}

function Pill({ status, children }: { status: Status | string; children: React.ReactNode }) {
  const color = tone(status);
  return (
    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded whitespace-nowrap" style={{ color, background: `${color}14`, border: `1px solid ${color}33` }}>
      {children}
    </span>
  );
}

function Chip({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: C.fg2 }}>
      <span className="text-[9px] font-mono px-1 py-px rounded uppercase" style={{ color: C.fg1, background: "rgba(255,255,255,0.06)" }}>{label}</span>
      {value}
    </span>
  );
}

function Label({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mt-6 mb-2">
      <span className="text-[10px] font-mono uppercase tracking-wider" style={{ color: C.fg0 }}>{children}</span>
      {right}
    </div>
  );
}

function Action({ children, onClick, disabled, primary }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 text-[11px] font-mono font-medium px-2.5 py-1.5 rounded transition-colors disabled:opacity-40 disabled:cursor-default"
      style={primary ? { color: "#000", background: C.fg4 } : { color: C.fg3, background: "rgba(255,255,255,0.10)" }}
      onMouseEnter={e => { if (!disabled) e.currentTarget.style.background = primary ? "#fff" : "rgba(255,255,255,0.20)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = primary ? C.fg4 : "rgba(255,255,255,0.10)"; }}
    >
      {children}
    </button>
  );
}

function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-lg ${className}`} style={{ background: C.surface, border: `1px solid ${C.border}` }}>{children}</div>;
}

const inputStyle = { background: "rgba(255,255,255,0.04)", color: C.fg3, border: "1px solid rgba(255,255,255,0.08)" };

function Field({ label, hint, first, children }: { label: string; hint: string; first?: boolean; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[200px_1fr] gap-4 items-start px-4 py-3" style={{ borderTop: first ? undefined : `1px solid ${C.border}` }}>
      <span>
        <span className="block text-[12px]" style={{ color: C.fg4 }}>{label}</span>
        <span className="block text-[11px] mt-0.5 leading-snug" style={{ color: C.fg0 }}>{hint}</span>
      </span>
      {children}
    </label>
  );
}

function CheckResult({ check }: { check?: Check | "pending" }) {
  if (!check) return null;
  if (check === "pending") return <span className="text-[11px] font-mono" style={{ color: C.fg1 }}>проверяю…</span>;
  if (!check.ok) return <span className="text-[11px]" style={{ color: "#F26B6B" }}>{check.error}</span>;
  return (
    <span className="text-[11px]" style={{ color: C.green }}>
      отвечает{check.seconds !== undefined ? ` за ${check.seconds} с` : ""}{check.status ? ` · статус ${check.status}` : ""}
      {check.text && <span className="block mt-1 line-clamp-3" style={{ color: C.fg2 }}>{check.text}</span>}
    </span>
  );
}

function Quote({ who, children, color }: { who: string; children: React.ReactNode; color?: string }) {
  return (
    <div className="mt-2 pl-2.5 text-[12px] leading-relaxed" style={{ borderLeft: `2px solid ${color ?? "rgba(255,255,255,0.12)"}`, color: color ? "#f1c7c7" : C.fg2 }}>
      <div className="text-[9px] font-mono uppercase tracking-wider mb-0.5" style={{ color: C.fg0 }}>{who}</div>
      {children}
    </div>
  );
}

function Bubble({ children }: { children: React.ReactNode }) {
  return <div className="self-end max-w-[92%] px-3 py-2 rounded-2xl rounded-br-md text-[13px]" style={{ background: C.user, color: C.fg4 }}>{children}</div>;
}

function ListItem({ selected, onClick, dot, title, sub, right }: { selected: boolean; onClick: () => void; dot?: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode }) {
  return (
    <button
      className="w-full text-left p-2.5 rounded-lg transition-all duration-150"
      style={{ background: selected ? "rgba(255,255,255,0.08)" : "transparent", border: selected ? "1px solid rgba(255,255,255,0.15)" : "1px solid transparent" }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.background = "rgba(255,255,255,0.04)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = selected ? "rgba(255,255,255,0.08)" : "transparent"; }}
      onClick={onClick}
    >
      <div className="flex items-center gap-2">
        {dot ?? <div className="size-2 flex-shrink-0" />}
        <div className="min-w-0 flex-1 overflow-hidden">
          <div className="text-[13px] font-medium truncate" style={{ color: C.fg4 }}>{title}</div>
          {sub && <div className="text-[10px] mt-0.5 truncate" style={{ color: C.fg0 }}>{sub}</div>}
        </div>
        {right}
      </div>
    </button>
  );
}

function Page({ title, lede, actions, children }: { title: string; lede: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="max-w-[1080px] mx-auto px-8 py-7">
      <div className="text-[21px] font-medium" style={{ ...titleFont, color: C.fg5 }}>{title}</div>
      <div className="text-[13px] mt-1.5 max-w-[820px] leading-relaxed" style={{ color: C.fg1 }}>{lede}</div>
      {actions && <div className="flex items-center gap-2 flex-wrap mt-4">{actions}</div>}
      {children}
    </div>
  );
}

function JobLine({ state, kind }: { state: LabState; kind: string }) {
  const j = state.job;
  if (j.running && j.kind === kind)
    return (
      <span className="inline-flex items-center gap-2 text-[11px] font-mono" style={{ color: C.fg2 }}>
        <span className="size-2 rounded-full pulse-dot" style={{ background: C.accent }} />{j.progress.message}{j.progress.total ? ` · ${j.progress.done}/${j.progress.total}` : ""}
        <button className="px-1.5 py-0.5 rounded hover:bg-white/10" style={{ color: C.fg3, background: "rgba(255,255,255,0.06)" }}
          onClick={() => api("/api/job/stop", {}).catch(e => alert(e.message))}>остановить</button>
      </span>
    );
  if (!j.running && j.kind === kind && j.error)
    return j.error === "Остановлено"
      ? <span className="text-[11px] font-mono" style={{ color: C.fg1 }}>остановлено</span>
      : <span className="text-[11px] font-mono" style={{ color: "#F26B6B" }}>ошибка: {j.error}</span>;
  return null;
}

function Stat({ label, value, sub, color }: { label: string; value: React.ReactNode; sub: string; color?: string }) {
  return (
    <Panel className="px-4 py-3">
      <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: C.fg0 }}>{label}</div>
      <div className="text-[26px] mt-1 font-medium" style={{ ...titleFont, color: color ?? C.fg5 }}>{value}</div>
      <div className="text-[11px]" style={{ color: C.fg1 }}>{sub}</div>
    </Panel>
  );
}

function Trust({ label, text, ok }: { label: string; text: string; ok?: boolean }) {
  const color = ok === undefined ? C.fg0 : ok ? C.green : C.orange;
  return (
    <div className="flex items-start gap-2 text-[12px]" style={{ color: C.fg2 }}>
      <span className="mt-1.5 size-1.5 rounded-full flex-shrink-0" style={{ background: color }} />
      <span><span className="font-mono text-[10px] uppercase mr-1.5" style={{ color: C.fg1 }}>{label}</span>{text}</span>
    </div>
  );
}

const passShare = (items: Item[], cardId: string) => {
  const done = items.filter(i => i.cardId === cardId && (i.status === "PASS" || i.status === "FAIL"));
  return done.length ? done.filter(i => i.status === "PASS").length / done.length : null;
};

/** Accuracy per customer type, and the scenarios the ordinary customer passes but another type fails. */
function PersonaBreakdown({ state, run }: { state: LabState; run: LabRun }) {
  const byType = run.metric?.personas ?? {};
  const items = run.items ?? [];
  const breaks: { name: string; types: string[] }[] = [];
  for (const cardId of [...new Set(items.map(i => i.cardId))]) {
    const of = (id: string) => items.filter(i => i.cardId === cardId && (i.persona ?? DEFAULT_PERSONA) === id && ["PASS", "FAIL"].includes(i.status));
    const ordinary = of(DEFAULT_PERSONA);
    if (!ordinary.length || ordinary.some(i => i.status !== "PASS")) continue;
    const failing = state.personas.filter(p => p.id !== DEFAULT_PERSONA && of(p.id).some(i => i.status === "FAIL")).map(p => p.name);
    if (failing.length) breaks.push({ name: items.find(i => i.cardId === cardId)!.name, types: failing });
  }
  return (
    <div className="grid grid-cols-2 gap-3 mt-6">
      <Panel className="px-4 py-3">
        <div className="text-[10px] font-mono uppercase tracking-wider mb-2" style={{ color: C.fg0 }}>по типам клиентов</div>
        {state.personas.filter(p => byType[p.id]).map(p => {
          const v = byType[p.id];
          return (
            <div key={p.id} className="grid grid-cols-[110px_1fr_44px] gap-3 items-center py-1 text-[12px]" style={{ color: C.fg2 }} title={p.note}>
              <span style={{ color: C.fg4 }}>{p.name}</span>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.07)" }}><div className="h-full" style={{ width: `${v.accuracy ?? 0}%`, background: C.fg3 }} /></div>
              <span className="font-mono text-right" style={{ color: C.fg4 }}>{v.accuracy ?? "—"}%</span>
            </div>
          );
        })}
        <div className="text-[11px] mt-2" style={{ color: C.fg1 }}>доля разговоров, где агент выполнил все критерии, для каждого типа клиента</div>
      </Panel>
      <Panel className="px-4 py-3">
        <div className="text-[10px] font-mono uppercase tracking-wider mb-2" style={{ color: C.fg0 }}>ломается от манеры общения</div>
        {breaks.slice(0, 8).map(b => (
          <div key={b.name} className="text-[12px] py-1" style={{ color: C.fg2 }}>
            <span style={{ color: C.fg4 }}>{b.name}</span> <span style={{ color: C.fg1 }}>· обычный клиент проходит, не проходит: </span><span style={{ color: "#F26B6B" }}>{b.types.join(", ")}</span>
          </div>
        ))}
        {!breaks.length && <div className="text-[12px]" style={{ color: C.fg1 }}>Таких сценариев нет: там, где обычный клиент проходит, проходят и остальные.</div>}
      </Panel>
    </div>
  );
}

/** Top failure reasons of a run and what changed against the previous run of the same agent. */
function Insights({ run, previous }: { run: LabRun; previous: LabRun | null }) {
  const items = run.items ?? [];
  const reasons = new Map<string, number>();
  for (const i of items) for (const r of i.rules) if (r.status === "FAIL") reasons.set(r.rule, (reasons.get(r.rule) ?? 0) + 1);
  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const cards = [...new Map(items.map(i => [i.cardId, i.name])).entries()];
  const better: string[] = [], worse: string[] = [];
  if (previous?.items) for (const [id, name] of cards) {
    const now = passShare(items, id), before = passShare(previous.items, id);
    if (now === null || before === null || now === before) continue;
    (now > before ? better : worse).push(name);
  }
  return (
    <div className="grid grid-cols-2 gap-3 mt-6">
      <Panel className="px-4 py-3">
        <div className="text-[10px] font-mono uppercase tracking-wider mb-2" style={{ color: C.fg0 }}>частые причины провала</div>
        {top.map(([rule, n]) => (
          <div key={rule} className="flex gap-3 text-[12px] py-1" style={{ color: C.fg2 }}>
            <span className="font-mono w-6 text-right flex-shrink-0" style={{ color: "#F26B6B" }}>{n}</span><span>{rule}</span>
          </div>
        ))}
        {!top.length && <div className="text-[12px]" style={{ color: C.fg1 }}>Провалов нет</div>}
      </Panel>
      <Panel className="px-4 py-3">
        <div className="text-[10px] font-mono uppercase tracking-wider mb-2" style={{ color: C.fg0 }}>
          {previous ? `против прогона ${when(previous.startedAt)}` : "сравнение с прошлым прогоном"}
        </div>
        {!previous && <div className="text-[12px]" style={{ color: C.fg1 }}>Это первый прогон этого агента.</div>}
        {previous && (
          <div className="flex flex-col gap-1 text-[12px]" style={{ color: C.fg2 }}>
            <div><span className="font-mono" style={{ color: C.green }}>лучше: {better.length}</span> {better.slice(0, 4).join(", ")}</div>
            <div><span className="font-mono" style={{ color: "#F26B6B" }}>хуже: {worse.length}</span> {worse.slice(0, 4).join(", ")}</div>
            <div style={{ color: C.fg1 }}>без изменений: {cards.length - better.length - worse.length}</div>
          </div>
        )}
      </Panel>
    </div>
  );
}

/* ---------- step views ---------- */

const SOURCE_KIND: Record<string, string> = { tools: "инструменты", knowledge: "база знаний", prompt: "промпт" };

function AgentView({ state }: { state: LabState }) {
  const saved = state.settings;
  const [form, setForm] = useState({ prodUrl: saved.prodUrl, epk: saved.epk.join("\n"), repo: saved.repo });
  const [checks, setChecks] = useState<Record<string, Check | "pending">>({});
  const dirty = form.prodUrl !== saved.prodUrl || form.epk !== saved.epk.join("\n") || form.repo !== saved.repo;
  const save = () => api("/api/settings", { prodUrl: form.prodUrl.trim(), epk: form.epk.split(/\s+/).filter(Boolean), repo: form.repo.trim() })
    .catch(e => alert(e.message));
  const check = (key: string, path: string) => {
    setChecks(c => ({ ...c, [key]: "pending" }));
    api<Check>(path, {}).then(r => setChecks(c => ({ ...c, [key]: r }))).catch(e => setChecks(c => ({ ...c, [key]: { ok: false, error: e.message } })));
  };
  const checkModels = () => {
    for (const role of ["main", "second"] as const) setChecks(c => ({ ...c, [role]: "pending" }));
    api<{ main: Check; second: Check }>("/api/models/check", {})
      .then(r => setChecks(c => ({ ...c, main: r.main, second: r.second })))
      .catch(e => setChecks(c => ({ ...c, main: { ok: false, error: e.message }, second: { ok: false, error: e.message } })));
  };
  const withRules = state.sources.filter(src => src.rules > 0 || src.kind !== "prompt");
  return (
    <Page title="Агент" lede="Какого агента проверяем, какие модели оценивают и откуда берутся правила проверки. Настройки хранятся на этом компьютере и в репозиторий не попадают.">
      <Label>подключение</Label>
      <Panel>
        <Field first label="Адрес агента на ИФТ" hint="HTTP-ручка агента, доступна из сети банка">
          <input value={form.prodUrl} onChange={e => setForm({ ...form, prodUrl: e.target.value })} placeholder="http://…/api/v1/ai/agents/…"
            className="w-full px-2 py-1.5 rounded text-[12px] font-mono outline-none" style={inputStyle} />
        </Field>
        <Field label="EPK клиентов" hint="по одному в строке; агент видит данные этих организаций. Пусто — клиент без авторизации">
          <textarea value={form.epk} onChange={e => setForm({ ...form, epk: e.target.value })} rows={3}
            className="w-full px-2 py-1.5 rounded text-[12px] font-mono outline-none resize-y" style={inputStyle} />
        </Field>
        <Field label="Код агента" hint="репозиторий: из него берутся промпты, инструменты, база знаний и запуск агента">
          <input value={form.repo} onChange={e => setForm({ ...form, repo: e.target.value })} placeholder="~/Desktop/aigw-local"
            className="w-full px-2 py-1.5 rounded text-[12px] font-mono outline-none" style={inputStyle} />
        </Field>
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderTop: `1px solid ${C.border}` }}>
          <Action primary disabled={!dirty} onClick={save}>сохранить</Action>
          {!dirty && <span className="text-[11px] font-mono" style={{ color: C.fg0 }}>сохранено</span>}
        </div>
      </Panel>

      <Label>агенты</Label>
      <div className="grid grid-cols-3 gap-3">
        {state.targets.map(t => (
          <Panel key={t.id} className="px-4 py-3 flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] font-medium" style={{ color: C.fg5 }}>{t.name}</span>
              <span className="text-[9px] font-mono px-1 py-px rounded uppercase" style={{ color: C.fg1, background: "rgba(255,255,255,0.06)" }}>{t.kind === "code" ? "код" : "http"}</span>
            </div>
            <div className="text-[10px] font-mono break-all" style={{ color: C.fg0 }}>{t.where || "адрес не задан"}</div>
            <div className="text-[11px] leading-snug" style={{ color: C.fg1 }}>{t.note}</div>
            {t.kind === "http" && (
              <div className="flex flex-col gap-1.5 mt-auto pt-1">
                <div><Action disabled={!t.ready} onClick={() => check(t.id, `/api/agents/${t.id}/check`)}>проверить связь</Action></div>
                <CheckResult check={checks[t.id]} />
              </div>
            )}
          </Panel>
        ))}
      </div>

      <Label>модели</Label>
      <Panel>
        {([["main", "судья и клиент", state.models.main], ["second", "второй судья", state.models.second]] as const).map(([key, role, model], i) => (
          <div key={key} className="grid grid-cols-[200px_1fr_auto] gap-4 items-center px-4 py-3" style={{ borderTop: i ? `1px solid ${C.border}` : undefined }}>
            <span className="text-[12px]" style={{ color: C.fg4 }}>{role}</span>
            <span className="text-[12px] font-mono" style={{ color: C.fg3 }}>{model ?? "новейшая GLM из каталога шлюза"}</span>
            <CheckResult check={checks[key]} />
          </div>
        ))}
        <div className="flex items-center gap-3 px-4 py-3" style={{ borderTop: `1px solid ${C.border}` }}>
          <Action onClick={checkModels}>проверить модели</Action>
          <span className="text-[11px]" style={{ color: C.fg1 }}>через {state.models.via}{state.models.via === "OpenRouter" ? " · сертификаты шлюза банка — в папку certs/" : ""}</span>
        </div>
      </Panel>

      <Label right={<JobLine state={state} kind="sources" />}>контекст агента</Label>
      <div className="flex items-center gap-2 mb-3">
        <Action primary disabled={state.job.running || !saved.repo} onClick={() => api("/api/sources", {}).catch(e => alert(e.message))}>
          <Bot className="size-3" />{state.sources.length ? "собрать заново из кода агента" : "собрать из кода агента"}
        </Action>
        <span className="text-[11px]" style={{ color: C.fg1 }}>промпты и инструменты агента: из них выделяются правила проверки</span>
      </div>
      {state.sources.length > 0 ? (
        <Panel>
          {withRules.map((src, i) => (
            <div key={src.id} className="grid grid-cols-[90px_1fr_auto] gap-3 items-center px-4 py-2 text-[12px]" style={{ borderTop: i ? `1px solid ${C.border}` : undefined }}>
              <span className="text-[10px] font-mono" style={{ color: C.fg1 }}>{SOURCE_KIND[src.kind] ?? src.kind}</span>
              <span className="font-mono text-[11px] truncate" style={{ color: C.fg3 }}>{src.origin}</span>
              <span className="font-mono text-[11px]" style={{ color: C.fg1 }}>{src.rules} {plural(src.rules, "правило", "правила", "правил")} · {Math.round(src.chars / 100) / 10} тыс. зн.</span>
            </div>
          ))}
          <div className="px-4 py-2 text-[11px]" style={{ borderTop: `1px solid ${C.border}`, color: C.fg0 }}>
            всего источников: {state.sources.length}{withRules.length < state.sources.length ? "; промпты без правил скрыты (классификаторы маршрутизации)" : ""}
          </div>
        </Panel>
      ) : (
        <Panel className="p-8 text-center text-[12px]"><span style={{ color: C.fg1 }}>Укажите код агента и соберите источники.</span></Panel>
      )}
    </Page>
  );
}

function LogsView({ state, onOpen }: { state: LabState; onOpen: (runId?: string) => void }) {
  const d = state.discover;
  const [count, setCount] = useState(d?.sampled ?? 60);
  const fileRef = useRef<HTMLInputElement>(null);
  const run = (replan = false) => api("/api/discover", { count, replan }).catch(e => alert(e.message));
  const load = async (file?: File) => {
    if (!file) return;
    try { await upload("/api/logs", file); } catch (e) { alert((e as Error).message); }
    if (fileRef.current) fileRef.current.value = "";
  };
  const pick = (
    <>
      <Action primary={!state.logs.total} disabled={state.job.running} onClick={() => fileRef.current?.click()}><Upload className="size-3" />{state.logs.total ? "новая выгрузка" : "загрузить выгрузку (.xlsx)"}</Action>
      <input ref={fileRef} type="file" accept=".xlsx,.jsonl" className="hidden" onChange={e => load(e.target.files?.[0])} />
    </>
  );
  if (!state.logs.total) {
    return (
      <Page title="Оценка логов" lede="Загрузите выгрузку диалогов чата из Excel (лист «Данные»: «Id диалога» и «Текст» с репликами CLIENT и AGENT). Файл остаётся на этом компьютере." actions={pick}>
        {null}
      </Page>
    );
  }
  const actions = (
    <>
      <Action primary onClick={() => run(false)} disabled={state.job.running || !state.sources.length}><FileText className="size-3" />{d ? "оценить логи заново" : "оценить логи"}</Action>
      <select value={count} onChange={e => setCount(+e.target.value)} className="px-2 py-1.5 rounded text-[11px] font-mono outline-none"
        style={{ background: "rgba(255,255,255,0.04)", color: C.fg3, border: "1px solid rgba(255,255,255,0.08)" }}>
        {[20, 40, 60, 100, 200].map(n => <option key={n} value={n}>{n} разговоров</option>)}
      </select>
      {d && <Action onClick={() => { if (confirm("Выделить правила заново? Следующая оценка пойдёт по новым правилам и не будет сравнима с текущей.")) run(true); }} disabled={state.job.running}>новые правила</Action>}
      <span className="text-[11px] font-mono" style={{ color: C.fg0 }}>всего в выгрузке: {state.logs.total}</span>
      {pick}
      <JobLine state={state} kind="discover" />
      {!state.sources.length && <span className="text-[11px]" style={{ color: C.orange }}>сначала соберите контекст на шаге «агент»</span>}
    </>
  );
  const lede = "Разговоры из логов проверяются по правилам из системного промпта агента. У каждого правила есть цитата из промпта. Агент при этом не запускается.";
  if (!d) return <Page title="Оценка логов" lede={lede} actions={actions}>{null}</Page>;
  const s = d.summary;
  const rules = d.topics.reduce((n, t) => n + t.rules.length, 0);
  const byDialogue = new Map(d.results.map(r => [r.dialogueId, r]));
  return (
    <Page title="Оценка логов" lede={lede} actions={actions}>
      <div className="grid grid-cols-4 gap-3 mt-6">
        <Stat label="проверено" value={s.checked} sub="разговоров из логов" />
        <Stat label="с нарушением" value={`${pct(s.failed, s.checked)}%`} sub={`${s.failed} ${plural(s.failed, "разговор", "разговора", "разговоров")}`} color="#F26B6B" />
        <Stat label="без нарушений" value={s.passed} sub={`нет данных: ${s.unmeasured}`} color={C.green} />
        <Stat label="правил" value={rules} sub={`в ${d.topics.length} темах`} />
      </div>
      {s.secondJudge && (
        <div className="mt-3 text-[12px]" style={{ color: C.fg2 }}>
          <span className="font-mono text-[10px] uppercase mr-1.5" style={{ color: C.fg1 }}>второй судья</span>
          согласен с итогом в {s.secondJudge.agree} из {s.secondJudge.checked} разговоров ({pct(s.secondJudge.agree, s.secondJudge.checked)}%)
        </div>
      )}
      <Label>частые нарушения</Label>
      <Panel>
        {s.patterns.map((p, i) => {
          const ex = p.examples[0];
          const trace = byDialogue.get(ex.dialogueId)?.runId;
          return (
            <div key={i} className="grid grid-cols-[64px_1fr] gap-4 px-4 py-4" style={{ borderTop: i ? `1px solid ${C.border}` : undefined }}>
              <div>
                <div className="text-[26px] leading-none" style={{ ...titleFont, color: "#F26B6B" }}>{p.count}</div>
                <div className="text-[10px] font-mono mt-1" style={{ color: C.fg0 }}>{plural(p.count, "разговор", "разговора", "разговоров")}</div>
              </div>
              <div className="min-w-0">
                <div className="text-[14px] font-medium" style={{ color: C.fg4 }}>{p.titles[0] || p.rule}</div>
                <div className="text-[12px] mt-0.5" style={{ color: C.fg2 }}>Правило: {p.rule} <span style={{ color: C.fg0 }}>· {p.topics.length > 1 ? `${p.topics.length} темы` : p.topics[0]}</span></div>
                <Quote who="промпт">«{p.quote}»</Quote>
                <Quote who="клиент">{ex.opening}</Quote>
                {ex.agentQuote && <Quote who="агент" color="#F26B6B">«{ex.agentQuote}»</Quote>}
                <div className="flex items-center gap-3 mt-2 text-[11px]" style={{ color: C.fg1 }}>
                  <span className="min-w-0">{ex.reason}</span>
                  {trace && <button className="font-mono flex-shrink-0 inline-flex items-center gap-0.5 hover:underline" style={{ color: C.accent }} onClick={() => onOpen(trace)}>открыть разговор<ChevronRight className="size-3" /></button>}
                </div>
              </div>
            </div>
          );
        })}
        {!s.patterns.length && <div className="p-8 text-center text-[12px]" style={{ color: C.fg1 }}>Нарушений не найдено</div>}
      </Panel>
      <div className="text-[11px] font-mono mt-3" style={{ color: C.fg0 }}>судья {d.model} · вердикт засчитывается только с цитатой из ответа агента · правила от {when(d.rulesSince ?? d.finishedAt)} · оценка {when(d.finishedAt)}</div>
    </Page>
  );
}

function CardView({ card, state, onBack }: { card: Card; state: LabState; onBack: () => void }) {
  const history = state.runs.filter(r => r.items).map(r => ({ run: r, item: r.items!.find(i => i.cardId === card.id) })).filter(x => x.item);
  return (
    <div className="max-w-[860px] mx-auto px-8 py-7">
      <button className="inline-flex items-center gap-1 text-[11px] font-mono mb-4 hover:underline" style={{ color: C.fg1 }} onClick={onBack}><ArrowLeft className="size-3" />все сценарии</button>
      <div className="flex items-center gap-2"><span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{card.topic}</span><Pill status={card.origin === "Ошибка из лога" ? "FAIL" : "NOT_APPLICABLE"}>{card.origin}</Pill></div>
      <div className="text-[21px] font-medium mt-1" style={{ ...titleFont, color: C.fg5 }}>{card.name}</div>
      {card.openings && Object.keys(card.openings).length > 0 ? (
        <>
          <Label>первая реплика у разных клиентов</Label>
          <Panel>
            {[{ id: DEFAULT_PERSONA, text: card.opening }, ...state.personas.filter(p => card.openings?.[p.id]).map(p => ({ id: p.id, text: card.openings![p.id] }))].map((row, i) => (
              <div key={row.id} className="grid grid-cols-[130px_1fr] gap-4 px-4 py-2.5" style={{ borderTop: i ? `1px solid ${C.border}` : undefined }}>
                <span className="text-[11px] pt-px" style={{ color: C.fg1 }}>{personaName(state, row.id)}{row.id === DEFAULT_PERSONA ? " · из лога" : ""}</span>
                <span className="text-[13px] leading-relaxed" style={{ color: C.fg4 }}>{row.text}</span>
              </div>
            ))}
          </Panel>
        </>
      ) : (
        <>
          <Label>первая реплика клиента (из лога)</Label>
          <div className="flex flex-col"><Bubble>{card.opening}</Bubble></div>
        </>
      )}
      <Label>ситуация клиента</Label>
      <div className="text-[13px] leading-relaxed" style={{ color: C.fg3 }}>{card.situation}</div>
      {card.world && (
        <>
          <Label>данные в системах банка (заглушки)</Label>
          <Panel className="px-4 py-3">
            <div className="text-[13px]" style={{ color: C.fg4 }}>{card.world.organization.name} · ИНН {card.world.organization.inn}</div>
            <div className="text-[12px]" style={{ color: C.fg2 }}>{card.world.organization.merchantName}, {card.world.organization.address}</div>
            <div className="text-[11px] font-mono mt-1" style={{ color: C.fg1 }}>
              {card.world.terminals.map(t => `${t.nameForClient} ${t.terminalId}${t.stateCode === "BLOCKED" ? " (заблокирован)" : ""}`).join(" · ")}
            </div>
            {Object.entries(card.world.tools).map(([name, value]) => (
              <details key={name} className="mt-2">
                <summary className="text-[11px] font-mono cursor-pointer" style={{ color: C.accent }}>{name}</summary>
                <pre className="text-[11px] font-mono mt-1 p-2 rounded overflow-auto max-h-64" style={{ background: "rgba(255,255,255,0.03)", color: C.fg2 }}>{JSON.stringify(value, null, 2)}</pre>
              </details>
            ))}
          </Panel>
        </>
      )}
      <Label>критерии оценки</Label>
      <Panel>
        {card.criteria.map((c, i) => (
          <div key={c.id} className="px-4 py-3" style={{ borderTop: i ? `1px solid ${C.border}` : undefined }}>
            <div className="text-[13px]" style={{ color: C.fg4 }}>{c.text}</div>
            <Quote who="промпт">«{c.quote}»</Quote>
          </div>
        ))}
      </Panel>
      {history.length > 0 && (
        <>
          <Label>результаты в прогонах</Label>
          <Panel>
            {history.map(({ run, item }, i) => (
              <div key={run.id} className="flex items-center gap-3 px-4 py-2.5 text-[12px]" style={{ borderTop: i ? `1px solid ${C.border}` : undefined, color: C.fg2 }}>
                <Pill status={item!.status}>{STATUS_TEXT[item!.status]}</Pill>
                <span style={{ color: C.fg4 }}>{run.targetName}</span>
                <span className="font-mono text-[11px]" style={{ color: C.fg0 }}>{run.version} · {when(run.startedAt)}</span>
              </div>
            ))}
          </Panel>
        </>
      )}
    </div>
  );
}

function CardsView({ state, onPick }: { state: LabState; onPick: (id: string) => void }) {
  const deck = state.cards?.cards ?? [];
  return (
    <Page
      title="Сценарии"
      lede="Сценарии собраны из оценённых логов: ситуация клиента взята из реального разговора, критерии из правил промпта. Сначала разговоры с нарушениями, затем остальные темы. Симулятор клиента критериев не видит."
      actions={<><Action primary disabled={state.job.running || !state.discover} onClick={() => api("/api/cards").catch(e => alert(e.message))}><FlaskConical className="size-3" />{deck.length ? "собрать заново" : "собрать сценарии"}</Action><JobLine state={state} kind="cards" /></>}
    >
      <div className="grid gap-3 mt-6" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
        {deck.map(c => (
          <button key={c.id} className="text-left rounded-lg p-4 flex flex-col gap-2.5 transition-colors" onClick={() => onPick(c.id)}
            style={{ background: C.surface, border: `1px solid ${C.border}` }}
            onMouseEnter={e => { e.currentTarget.style.borderColor = "rgba(255,255,255,0.16)"; }}
            onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; }}>
            <div className="flex items-center justify-between gap-2"><span className="text-[10px] font-mono truncate" style={{ color: C.fg0 }}>{c.topic}</span><Pill status={c.origin === "Ошибка из лога" ? "FAIL" : "NOT_APPLICABLE"}>{c.origin}</Pill></div>
            <div className="text-[15px] font-medium" style={{ color: C.fg5 }}>{c.name}</div>
            <Bubble>{c.opening}</Bubble>
            <div className="flex flex-col gap-1">
              {c.criteria.map(k => <div key={k.id} className="text-[12px] flex gap-1.5" style={{ color: C.fg2 }}><span style={{ color: C.accent }}>◇</span>{k.text}</div>)}
            </div>
          </button>
        ))}
      </div>
      {!deck.length && <Panel className="mt-6 p-8 text-center text-[12px]"><span style={{ color: C.fg1 }}>Сначала оцените логи, затем соберите сценарии.</span></Panel>}
    </Page>
  );
}

/** A conversation read from the run itself, when Workshop has no trace of it: the messages and the judge's rows. */
function Conversation({ item }: { item: Item }) {
  return (
    <div className="max-w-[860px] mx-auto px-6 py-5 flex flex-col gap-2">
      {item.conversation.map((m, k) => m.role === "customer"
        ? <Bubble key={k}>{m.text}</Bubble>
        : <div key={k} className="self-start max-w-[92%] px-3 py-2 rounded-2xl rounded-bl-md text-[13px] whitespace-pre-wrap" style={{ background: C.surface, border: `1px solid ${C.border}`, color: C.fg3 }}>{m.text}</div>)}
      {item.stage && <div className="text-[11px] font-mono" style={{ color: C.fg1 }}>{item.stage}</div>}
      {item.error && <div className="text-[12px]" style={{ color: C.orange }}>{item.error}</div>}
      {item.rules.length > 0 && (
        <Panel className="mt-3">
          {item.rules.map((r, k) => (
            <div key={r.ruleId} className="px-4 py-2.5 text-[12px]" style={{ borderTop: k ? `1px solid ${C.border}` : undefined }}>
              <div className="flex items-start gap-2"><Pill status={r.status}>{RULE_TEXT[r.status] ?? r.status}</Pill><span style={{ color: C.fg4 }}>{r.rule}</span></div>
              <div className="mt-1 pl-1" style={{ color: C.fg2 }}>{r.reason}</div>
              {r.agentQuote && <Quote who="агент">«{r.agentQuote}»</Quote>}
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

/** The settings of a new run: agent, customer types, repeats; the button says how many conversations it makes. */
function NewRun({ state, target, setTarget, onStarted }: { state: LabState; target: string; setTarget: (t: string) => void; onStarted?: () => void }) {
  const deck = state.cards?.cards ?? [];
  const [repeats, setRepeats] = useState(1);
  const [types, setTypes] = useState<string[]>([DEFAULT_PERSONA]);
  const toggleType = (id: string) => setTypes(t => t.includes(id) ? (t.length > 1 ? t.filter(x => x !== id) : t) : [...t, id]);
  const start = () => api("/api/runs", { target, repeats, personas: types }).then(() => onStarted?.()).catch(e => alert(e.message));
  const total = deck.length * types.length * repeats;
  const chosen = state.personas.filter(p => types.includes(p.id) && p.id !== DEFAULT_PERSONA);
  return (
    <Panel>
      <SettingRow first label="агент">
        <div className="flex gap-1.5 flex-wrap">
          {state.targets.map(t => <Choice key={t.id} on={t.id === target} onClick={() => setTarget(t.id)} title={t.note}>{t.name}</Choice>)}
        </div>
      </SettingRow>
      <SettingRow label="клиенты">
        <div className="flex gap-1.5 flex-wrap">
          {state.personas.map(p => <Choice key={p.id} on={types.includes(p.id)} onClick={() => toggleType(p.id)} title={p.note}>{p.name}</Choice>)}
        </div>
        <div className="text-[11px] mt-2 leading-relaxed" style={{ color: C.fg1 }}>
          {chosen.length ? chosen.map(p => `${p.name} — ${p.note}`).join("; ") : "Клиент пишет так, как в логе. Добавьте типы клиентов, чтобы увидеть, где агент ломается от манеры общения."}
        </div>
      </SettingRow>
      <SettingRow label="повторы">
        <div className="flex gap-1.5">
          {[1, 2, 3].map(n => <Choice key={n} on={repeats === n} onClick={() => setRepeats(n)}>{n === 1 ? "1 раз" : `${n} раза`}</Choice>)}
        </div>
      </SettingRow>
      <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3" style={{ borderTop: `1px solid ${C.border}` }}>
        <span className="text-[12px]" style={{ color: C.fg2 }}>
          {deck.length} {plural(deck.length, "сценарий", "сценария", "сценариев")} × {types.length} {plural(types.length, "клиент", "клиента", "клиентов")}{repeats > 1 ? ` × ${repeats} повтора` : ""} = <b style={{ color: C.fg5 }}>{total} {plural(total, "разговор", "разговора", "разговоров")}</b>
        </span>
        <Action primary disabled={state.job.running || !deck.length} onClick={start}><Play className="size-3" />запустить</Action>
      </div>
    </Panel>
  );
}

/** A run as Workshop shows runs: scenarios in the list on the left, the chosen conversation here with the judge's note. */
function RunStage({ state, run, itemId, target, setTarget, onOpen }: { state: LabState; run: LabRun | null; itemId: string | null; target: string; setTarget: (t: string) => void; onOpen: (runId?: string) => void }) {
  const [creating, setCreating] = useState(false);
  const items = run?.items ?? [];
  const selected = items.find(i => itemKey(i) === itemId) ?? items.find(i => i.status !== "RUNNING") ?? items[0];
  const index = selected ? items.indexOf(selected) : -1;
  const review = (decision: "agree" | "disagree" | null) =>
    run && api("/api/review", { run: run.id, index, decision }).catch(e => alert(e.message));
  if (!run) {
    return <Page title="Прогон" lede="Искусственный клиент начинает с первой реплики из лога и продолжает разговор по ситуации сценария. Судья проверяет каждый разговор по критериям."><div className="mt-5"><NewRun state={state} target={target} setTarget={setTarget} /></div><div className="mt-3"><JobLine state={state} kind="run" /></div></Page>;
  }
  const disputes = items.filter(disputed).length;
  return (
    <div className="h-full flex flex-col">
      <div className="flex-shrink-0 flex items-center gap-3 flex-wrap px-4 py-2.5" style={{ borderBottom: `1px solid ${C.border}` }}>
        <div className="min-w-0 flex-1">
          <span className="text-[14px] font-medium" style={{ color: C.fg5 }}>{run.targetName}</span>
          <span className="text-[12px] ml-2" style={{ color: C.fg1 }}>версия {run.version} · {when(run.startedAt)}{disputes ? ` · спор судей: ${disputes}` : ""}</span>
        </div>
        <JobLine state={state} kind="run" />
        <JobLine state={state} kind="rejudge" />
        {run.status !== "running" && <Action disabled={state.job.running} onClick={() => api(`/api/runs/${run.id}/rejudge`, {}).catch(e => alert(e.message))}><RotateCcw className="size-3" />переоценить без агента</Action>}
        <span className="text-[20px] px-1" style={{ ...titleFont, color: C.fg5 }} title="точность прогона">{run.metric?.accuracy ?? "—"}%</span>
        <Action primary disabled={state.job.running} onClick={() => setCreating(true)}><Play className="size-3" />новый прогон</Action>
      </div>
      {run.error && <div className="flex-shrink-0 px-4 py-2 text-[12px]" style={{ color: "#F26B6B", borderBottom: `1px solid ${C.border}` }}>{run.error}</div>}
      {selected && (
        <div className="flex-shrink-0 flex items-center gap-2 flex-wrap px-4 py-2" style={{ background: "rgba(255,255,255,0.03)", borderBottom: `1px solid ${C.border}` }}>
          <Pill status={selected.status}>{STATUS_TEXT[selected.status]}</Pill>
          <span className="text-[13px] font-medium" style={{ color: C.fg4 }}>{selected.name}</span>
          <PersonaTag state={state} id={selected.persona} />
          {selected.attempt && selected.attempt > 1 && <span className="text-[11px] font-mono" style={{ color: C.fg1 }}>повтор {selected.attempt}</span>}
          {disputed(selected) && <span className="text-[10px] font-mono px-1 rounded" style={{ color: C.orange, background: `${C.orange}14` }}>спор судей: второй судья — {STATUS_TEXT[selected.second!.status as Status]}</span>}
          <span className="ml-auto inline-flex items-center gap-1.5">
            {["PASS", "FAIL"].includes(selected.status) && <span className="text-[11px]" style={{ color: C.fg1 }}>судья прав?</span>}
            {["PASS", "FAIL"].includes(selected.status) && (["agree", "disagree"] as const).map(d => (
              <button key={d} onClick={() => review(selected.review === d ? null : d)} className="text-[11px] font-mono px-2 py-0.5 rounded"
                style={{ color: selected.review === d ? "#000" : C.fg2, background: selected.review === d ? (d === "agree" ? C.green : "#F26B6B") : "rgba(255,255,255,0.07)" }}>
                {d === "agree" ? "верно" : "неверно"}
              </button>
            ))}
          </span>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto sb">
        {selected?.runId
          ? <RunDetail key={selected.runId} runId={selected.runId} />
          : selected
            ? <Conversation item={selected} />
            : <div className="h-full flex items-center justify-center text-[12px]" style={{ color: C.fg1 }}>В прогоне нет разговоров</div>}
      </div>
      {creating && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.6)" }} onClick={() => setCreating(false)}>
          <div className="w-full max-w-[760px]" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[15px] font-medium" style={{ ...titleFont, color: C.fg5 }}>Новый прогон</span>
              <button className="text-[12px] font-mono hover:underline" style={{ color: C.fg1 }} onClick={() => setCreating(false)}>закрыть</button>
            </div>
            <NewRun state={state} target={target} setTarget={setTarget} onStarted={() => { setCreating(false); onOpen(undefined); }} />
          </div>
        </div>
      )}
    </div>
  );
}

function AccuracyView({ state, run: selected, onPickRun }: { state: LabState; run: LabRun | null; onPickRun: (id: string) => void }) {
  let run = selected;
  const history = state.runs.filter(r => r.metric && r.metric.total && r.status !== "running");
  const deck = state.cards?.cards ?? [];
  const recent = history.slice(0, 4);
  const [details, setDetails] = useState<Record<string, LabRun>>({});
  useEffect(() => {
    recent.forEach(r => { if (!details[r.id]) api<LabRun>(`/api/runs/${r.id}`).then(full => setDetails(d => ({ ...d, [r.id]: full }))).catch(() => {}); });
  }, [recent.map(r => r.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  // While a run is still going, the number shown is the last finished run's.
  const finished = run?.metric?.total && run.status !== "running" ? run : history[0] ? details[history[0].id] ?? null : null;
  if (!finished?.metric || !finished.metric.total) {
    return <Page title="Точность агента" lede={history.length ? "Загружаю…" : "Сначала прогоните сценарии на агенте."}>{null}</Page>;
  }
  run = finished;
  const m = finished.metric;
  return (
    <Page title="Точность агента" lede="Доля разговоров, в которых агент выполнил все критерии сценария. Разговоры со статусом «не измерено» в расчёт не входят.">
      <div className="grid grid-cols-[1fr_1.35fr] gap-3 mt-6">
        <Panel className="px-7 py-6">
          <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: C.fg0 }}>{run.targetName} · {run.version}</div>
          <div className="flex items-baseline mt-2" style={{ ...titleFont, color: C.fg5 }}>
            <span className="text-[112px] leading-none tracking-tight"><NumberFlow value={m.accuracy ?? 0} /></span>
            <span className="text-[44px] ml-1" style={{ color: C.fg2 }}>%</span>
          </div>
          <div className="text-[15px] mt-3" style={{ color: C.fg4 }}>
            агент выполнил все критерии в <b>{m.passed}</b> из <b>{m.measured}</b> {m.repeats ? plural(m.measured, "разговора", "разговоров", "разговоров") : plural(m.measured, "сценария", "сценариев", "сценариев")}
            {m.repeats && <span className="text-[12px]" style={{ color: C.fg1 }}> · {m.repeats.scenarios} сценариев × {m.repeats.attempts} повтора</span>}
          </div>
          <div className="flex h-1.5 rounded-full overflow-hidden mt-5" style={{ background: "rgba(255,255,255,0.06)" }}>
            <div style={{ width: `${pct(m.passed, m.total)}%`, background: C.green }} />
            <div style={{ width: `${pct(m.failed, m.total)}%`, background: "#F26B6B" }} />
            <div style={{ width: `${pct(m.unmeasured, m.total)}%`, background: C.orange }} />
          </div>
          <div className="flex gap-4 mt-3 flex-wrap">
            <Chip label="пройдено" value={m.passed} /><Chip label="не пройдено" value={m.failed} /><Chip label="не измерено" value={m.unmeasured} />
          </div>
          <div className="text-[11px] mt-4 leading-relaxed" style={{ color: C.fg1 }}>«Не измерено»: агент не ответил или судье не на что опереться. {when(run.startedAt)}</div>
          <div className="mt-5 pt-4 flex flex-col gap-2" style={{ borderTop: `1px solid ${C.border}` }}>
            <div className="text-[10px] font-mono uppercase tracking-wider" style={{ color: C.fg0 }}>проверка оценки</div>
            <Trust label="второй судья" ok={m.secondJudge ? m.secondJudge.agree / m.secondJudge.checked >= 0.8 : undefined}
              text={m.secondJudge ? `согласен в ${m.secondJudge.agree} из ${m.secondJudge.checked} разговоров` : "не запускался"} />
            <Trust label="повторы" ok={m.repeats ? m.repeats.stable / m.repeats.scenarios >= 0.8 : undefined}
              text={m.repeats ? `у ${m.repeats.stable} из ${m.repeats.scenarios} сценариев одинаковый итог во всех повторах` : "прогон без повторов"} />
            <Trust label="доказательства" ok text="каждый вердикт подтверждён цитатой из ответа агента" />
            <Trust label="человек" ok={m.human ? m.human.agree / m.human.reviewed >= 0.8 : undefined}
              text={m.human ? `проверено ${m.human.reviewed}, судья прав в ${m.human.agree}` : "не проверялось (кнопки «верно / неверно» в прогоне)"} />
          </div>
        </Panel>
        <Panel>
          <div className="px-4 pt-3 pb-1 text-[10px] font-mono uppercase tracking-wider" style={{ color: C.fg0 }}>история прогонов</div>
          {history.map(r => (
            <button key={r.id} onClick={() => onPickRun(r.id)} className="w-full text-left grid grid-cols-[1fr_120px_58px] gap-3 items-center px-4 py-2.5 transition-colors hover:bg-white/[0.03]"
              style={{ borderTop: `1px solid ${C.border}`, background: r.id === run.id ? C.selected : undefined }}>
              <div className="min-w-0">
                <div className="text-[13px] truncate" style={{ color: C.fg4 }}>{r.targetName}</div>
                <div className="text-[10px] font-mono truncate" style={{ color: C.fg0 }}>{r.version} · {when(r.startedAt)}</div>
              </div>
              <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.07)" }}><div className="h-full" style={{ width: `${r.metric?.accuracy ?? 0}%`, background: C.fg3 }} /></div>
              <div className="text-[15px] text-right" style={{ ...titleFont, color: C.fg5 }}>{r.metric?.accuracy ?? "—"}%</div>
            </button>
          ))}
        </Panel>
      </div>
      {m.personas && <PersonaBreakdown state={state} run={finished} />}
      <Insights run={finished} previous={history.filter(r => r.id !== finished.id && r.target === finished.target)[0] ? details[history.filter(r => r.id !== finished.id && r.target === finished.target)[0].id] ?? null : null} />
      <Label>итоги по сценариям</Label>
      <Panel className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr style={{ color: C.fg0 }}>
              <th className="text-left font-mono font-normal text-[10px] px-4 py-2">сценарий</th>
              {recent.map(r => <th key={r.id} className="font-mono font-normal text-[10px] px-3 py-2 text-center whitespace-nowrap">{r.targetName}<br />{when(r.startedAt)}</th>)}
            </tr>
          </thead>
          <tbody>
            {deck.map(c => (
              <tr key={c.id} style={{ borderTop: `1px solid ${C.border}` }}>
                <td className="px-4 py-2" style={{ color: C.fg3 }}>{c.name}</td>
                {recent.map(r => {
                  const attempts = details[r.id]?.items?.filter(i => i.cardId === c.id) ?? [];
                  return <td key={r.id} className="px-3 py-2 text-center">{attempts.length ? attempts.map((item, k) => <span key={k} className="font-mono" style={{ color: tone(item.status) }}>{item.status === "PASS" ? "✓" : item.status === "FAIL" ? "✗" : "?"}</span>) : <span style={{ color: C.fg0 }}>·</span>}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </Page>
  );
}

/* ---------- page ---------- */

export function LabPage() {
  const navigate = useNavigate();
  const params = useParams<{ step?: string; itemId?: string }>();
  const step: Step = STEPS.includes(params.step as Step) ? params.step as Step : "agent";
  const itemId = params.itemId ? decodeURIComponent(params.itemId) : null;
  const [state, setState] = useState<LabState | null>(null);
  const [offline, setOffline] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<LabRun | null>(null);
  const [target, setTargetState] = useState(() => { try { return localStorage.getItem("lab.target") || "local-http"; } catch { return "local-http"; } });
  const setTarget = (t: string) => { setTargetState(t); try { localStorage.setItem("lab.target", t); } catch { /* ignore */ } };

  const refresh = useCallback(async () => {
    try {
      const next = await api<LabState>("/api/state");
      setState(next);
      setOffline(false);
      const active = next.job.running && next.job.kind === "run" ? next.job.progress.run : null;
      const id = active ?? runId ?? next.runs[0]?.id ?? null;
      if (active && active !== runId) setRunId(active);
      if (id) setRun(await api<LabRun>(`/api/runs/${id}`));
    } catch {
      setOffline(true);
    }
  }, [runId]);

  useEffect(() => {
    let timer: number;
    let alive = true;
    const loop = async () => {
      await refresh();
      if (alive) timer = window.setTimeout(loop, state?.job.running ? 1200 : 4000);
    };
    loop();
    return () => { alive = false; clearTimeout(timer); };
  }, [refresh, state?.job.running]);

  const go = (s: Step, item?: string | null) => navigate(item ? `/lab/${s}/${encodeURIComponent(item)}` : `/lab/${s}`);
  const pickRun = (id: string) => { setRunId(id); api<LabRun>(`/api/runs/${id}`).then(setRun).catch(() => {}); };

  const d = state?.discover;
  const deck = state?.cards?.cards ?? [];
  const lastScored = state?.runs.find(r => r.metric && r.metric.accuracy !== null && r.status !== "running");
  const steps: { id: Step; n: string; title: string; value: string; icon: typeof FileText }[] = [
    { id: "agent", n: "01", title: "агент", icon: Bot, value: state ? `${state.sources.length ? `${state.sources.length} ${plural(state.sources.length, "источник", "источника", "источников")}` : "контекст не собран"} · ${state.models.via}` : "" },
    { id: "logs", n: "02", title: "логи", icon: FileText, value: d ? `${d.summary.checked} разговоров · ${pct(d.summary.failed, d.summary.checked)}% с нарушениями` : state?.logs.total ? `${state.logs.total} в выгрузке · не оценены` : "выгрузка не загружена" },
    { id: "cards", n: "03", title: "сценарии", icon: FlaskConical, value: deck.length ? `${deck.length} ${plural(deck.length, "сценарий", "сценария", "сценариев")}` : "ещё не собраны" },
    { id: "run", n: "04", title: "прогон", icon: MessagesSquare, value: state?.runs.length ? `${state.runs.length} ${plural(state.runs.length, "прогон", "прогона", "прогонов")}` : "ещё не было" },
    { id: "accuracy", n: "05", title: "точность", icon: Gauge, value: lastScored ? `${lastScored.metric!.accuracy}% · ${lastScored.targetName}` : "—" },
  ];

  const runTypes = step === "run" && run?.items ? state?.personas.filter(p => run.items!.some(i => (i.persona ?? DEFAULT_PERSONA) === p.id)) ?? [] : [];
  const listItems = useMemo(() => {
    if (!state) return null;
    if (step === "logs" && d) {
      return d.results.map(r => {
        const fail = r.rules.find(x => x.status === "FAIL");
        const topic = d.topics.find(t => t.id === r.topicId)?.title ?? "";
        return <ListItem key={r.dialogueId} selected={!!r.runId && r.runId === itemId} onClick={() => r.runId && go("logs", r.runId)}
          dot={<Dot status={r.status} />} title={r.opening} sub={fail?.title || `${LOG_TEXT[r.status] ?? ""} · ${topic}`} />;
      });
    }
    if (step === "cards") {
      return deck.map(c => <ListItem key={c.id} selected={c.id === itemId} onClick={() => go("cards", c.id)}
        dot={<Dot status={c.origin === "Ошибка из лога" ? "FAIL" : "NOT_APPLICABLE"} />} title={c.name} sub={`${c.origin} · ${c.topic}`} />);
    }
    if (step === "run" && run?.items) {
      const items = run.items;
      const current = items.find(i => itemKey(i) === itemId) ?? items.find(i => i.status !== "RUNNING") ?? items[0];
      const mark = (st: Status) => st === "PASS" ? "✓" : st === "FAIL" ? "✗" : st === "RUNNING" ? "…" : "?";
      const legend = runTypes.length > 1
        ? <div key="legend" className="px-2.5 pb-1 text-[10px] leading-relaxed" style={{ color: C.fg1 }}>значки слева направо: {runTypes.map(p => p.name).join(", ")}</div>
        : null;
      return [legend, ...[...new Map(items.map(i => [i.cardId, i.name])).entries()].map(([cardId, name]) => {
        const own = items.filter(i => i.cardId === cardId);
        const status: Status = own.some(i => i.status === "RUNNING") ? "RUNNING" : own.some(i => i.status === "FAIL") ? "FAIL" : own.every(i => i.status === "PASS") ? "PASS" : "UNMEASURED";
        const active = own.includes(current!);
        return (
          <div key={cardId} className="px-2.5 py-2 rounded-lg" style={{ background: active ? "rgba(255,255,255,0.06)" : undefined }}>
            <button className="w-full flex items-center gap-2 text-left" onClick={() => go("run", itemKey(own[0]))}>
              <Dot status={status} pulse={status === "RUNNING"} />
              <span className="text-[13px] truncate" style={{ color: C.fg4 }} title={name}>{name}</span>
            </button>
            {own.length > 1 && (
              <div className="flex gap-1 mt-1.5 pl-4 flex-wrap">
                {own.map(i => {
                  const on = i === current;
                  return (
                    <button key={`${i.persona ?? DEFAULT_PERSONA}-${i.attempt ?? 1}`} onClick={() => go("run", itemKey(i))}
                      title={`${personaName(state, i.persona)}${i.attempt && i.attempt > 1 ? ` · повтор ${i.attempt}` : ""}: ${STATUS_TEXT[i.status]}`}
                      className="h-5 min-w-[22px] px-1 rounded text-[11px] transition-colors"
                      style={{ color: tone(i.status), background: `${tone(i.status)}${on ? "40" : "1a"}`, boxShadow: on ? `inset 0 0 0 1px ${tone(i.status)}` : undefined }}>
                      {mark(i.status)}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })];
    }
    if (step === "accuracy") {
      return state.runs.map(r => <ListItem key={r.id} selected={r.id === run?.id} onClick={() => pickRun(r.id)}
        dot={<Dot status={r.status === "running" ? "RUNNING" : "NOT_APPLICABLE"} pulse={r.status === "running"} />}
        title={`${r.targetName} · ${r.metric?.accuracy ?? "—"}%`} sub={`${r.version} · ${when(r.startedAt)}`} />);
    }
    return null;
  }, [state, step, itemId, run]); // eslint-disable-line react-hooks/exhaustive-deps

  const listTitle = step === "agent" ? "" : step === "logs" ? "разговоры из логов" : step === "cards" ? "сценарии" : step === "run" ? "сценарии прогона" : "прогоны";
  const card = step === "cards" && itemId ? deck.find(c => c.id === itemId) : undefined;
  const traceId = step === "logs" && itemId ? itemId : null;

  return (
    <div className="h-full flex">
      <div className="w-[280px] flex-shrink-0 flex flex-col" style={{ borderRight: `1px solid ${C.border}` }}>
        <div className="p-3" style={{ borderBottom: `1px solid ${C.border}` }}>
          <div className="flex items-center justify-between mb-2.5">
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full" style={{ background: offline ? C.red : C.green, opacity: offline ? 1 : 0.6 }} />
              <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{offline ? "agent lab недоступен" : "agent lab"}</span>
            </div>
            <span className="text-[10px] font-mono truncate max-w-[150px]" style={{ color: C.fg0 }} title={state?.model}>{state?.job.running ? "работает…" : state?.model}</span>
          </div>
          <div className="text-[13px] font-medium" style={{ color: C.fg4 }}>Агент эквайринга</div>
          <div className="text-[11px]" style={{ color: C.fg1 }}>СберБизнес · чат поддержки</div>
        </div>
        <div className="p-2 space-y-0.5" style={{ borderBottom: `1px solid ${C.border}` }}>
          {steps.map(s => {
            const active = s.id === step;
            return (
              <button key={s.id} onClick={() => go(s.id)} className="w-full text-left px-2.5 py-2 rounded-lg transition-all duration-150"
                style={{ background: active ? "rgba(255,255,255,0.08)" : "transparent", border: active ? "1px solid rgba(255,255,255,0.15)" : "1px solid transparent" }}>
                <div className="flex items-center gap-2">
                  <s.icon className="size-3.5 flex-shrink-0" style={{ color: active ? C.fg4 : C.fg0 }} />
                  <span className="text-[10px] font-mono" style={{ color: C.fg0 }}>{s.n}</span>
                  <span className="text-[13px] font-medium" style={{ color: active ? C.fg5 : C.fg3 }}>{s.title}</span>
                </div>
                <div className="text-[10px] font-mono mt-0.5 pl-[22px] truncate" style={{ color: C.fg1 }}>{s.value}</div>
              </button>
            );
          })}
        </div>
        <div className="px-3 pt-3 pb-1 text-[10px] font-mono uppercase tracking-wider truncate" style={{ color: C.fg0 }}>{listTitle}</div>
        <div className="flex-1 overflow-auto p-2 pt-0 space-y-0.5 sb">{listItems}</div>
      </div>

      <div className="flex-1 min-w-0 overflow-auto sb relative">
        {offline && !state && (
          <div className="h-full flex items-center justify-center">
            <div className="text-center" style={titleFont}>
              <div className="text-lg" style={{ color: C.fg4 }}>Agent Lab не запущен.</div>
              <div className="text-[14px] mt-3" style={{ color: C.fg1 }}>Запустите <code className="rounded bg-white/10 px-1.5 py-0.5 font-mono text-white/90">sh bin/start.sh</code></div>
            </div>
          </div>
        )}
        {state && traceId && (
          <div className="h-full flex flex-col">
            <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5" style={{ background: "rgba(255,255,255,0.06)", borderBottom: `1px solid ${C.border}` }}>
              <button className="inline-flex items-center gap-1 text-[12px] hover:underline" style={{ color: C.fg2 }} onClick={() => go(step)}>
                <ArrowLeft className="size-3" />{step === "logs" ? "назад к логам" : "назад к прогону"}
              </button>
              <span className="text-[11px] font-mono" style={{ color: C.fg0 }}>· {step === "logs" ? "разговор из лога, вердикт судьи в заметке сверху" : "симулятор клиента и агент, вердикт судьи в заметке сверху"}</span>
            </div>
            <div className="flex-1 min-h-0 overflow-auto sb"><RunDetail key={traceId} runId={traceId} /></div>
          </div>
        )}
        {state && !traceId && step === "agent" && <AgentView state={state} />}
        {state && !traceId && step === "logs" && <LogsView state={state} onOpen={id => id && go("logs", id)} />}
        {state && !traceId && step === "cards" && (card ? <CardView card={card} state={state} onBack={() => go("cards")} /> : <CardsView state={state} onPick={id => go("cards", id)} />)}
        {state && step === "run" && <RunStage state={state} run={run} itemId={itemId} target={target} setTarget={setTarget} onOpen={id => go("run", id)} />}
        {state && !traceId && step === "accuracy" && <AccuracyView state={state} run={run} onPickRun={pickRun} />}
      </div>
    </div>
  );
}
