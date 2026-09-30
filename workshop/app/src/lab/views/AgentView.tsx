import { useEffect, useState } from "react";
import { BookOpen, Bot, Check, CircleAlert, Code, Globe, Loader2, ShieldCheck, SlidersHorizontal, Wrench, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { count, plural, thousands } from "../format";
import { JobLine } from "../JobLine";
import { setupSteps } from "../nav";
import { NextStep, SetupSteps } from "../Setup";
import { TagInput } from "../TagInput";
import { useToast } from "../toast";
import type { Check as CheckResult, LabState } from "../types";
import { Badge, Button, EmptyState, Field, Input, Label, Page, Section, Stat, Strip } from "../ui";

const SOURCE: Record<string, { label: string; icon: LucideIcon }> = {
  prompt: { label: "Промпт", icon: Bot },
  tools: { label: "Инструменты", icon: Wrench },
  knowledge: { label: "База знаний", icon: BookOpen },
};

type Checks = Record<string, CheckResult | "pending">;

/** The service answers `ok: false` both when the agent is unreachable (with `error`) and when it answers with a non-200 status. */
function Verdict({ check }: { check?: CheckResult | "pending" }) {
  if (!check) return null;
  if (check === "pending") return <Badge hue="accent"><Loader2 className="size-3 animate-spin" />проверяю…</Badge>;
  if (!check.ok) return check.error ? <Badge hue="bad" icon={CircleAlert}>не отвечает</Badge> : <Badge hue="warn" icon={CircleAlert}>статус {check.status ?? "?"}</Badge>;
  return <Badge hue="ok" icon={Check}>отвечает{check.seconds !== undefined ? ` · ${String(check.seconds).replace(".", ",")} с` : ""}</Badge>;
}

function VerdictDetail({ check }: { check?: CheckResult | "pending" }) {
  if (!check || check === "pending") return null;
  if (!check.ok) {
    return check.error
      ? <div className="mt-2 text-body text-lab-bad">{check.error}</div>
      : <div className="mt-2 text-body text-lab-warn">Агент ответил не обычным ответом{check.text ? `: ${check.text}` : ""}. Так бывает, когда разговор передан оператору.</div>;
  }
  const version = check.version && check.version !== "не сообщается" ? `Версия ${check.version}. ` : "";
  return check.text
    ? <div className="mt-2 line-clamp-2 border-l-2 border-lab-strong pl-2.5 text-body text-lab-mute">{version}{check.text}</div>
    : version ? <div className="mt-2 text-body text-lab-mute">{version}</div> : null;
}

/** Step 1: which agent is tested, where its code is, which models judge — and the criteria its prompts and tools give. */
export function AgentView({ state }: { state: LabState }) {
  const { error } = useToast();
  const saved = state.settings;
  const [base, setBase] = useState(saved);
  const [form, setForm] = useState(saved);
  const [checks, setChecks] = useState<Checks>({});
  const savedKey = `${saved.prodUrl}|${saved.repo}|${saved.epk.join(",")}`;
  useEffect(() => { setBase(saved); }, [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = form.prodUrl !== base.prodUrl || form.repo !== base.repo || form.epk.join(",") !== base.epk.join(",");
  const save = () => api("/api/settings", { prodUrl: form.prodUrl.trim(), epk: form.epk, repo: form.repo.trim() }).then(() => setBase(form)).catch(error);
  const check = (key: string, path: string) => {
    setChecks(c => ({ ...c, [key]: "pending" }));
    return api<CheckResult>(path, {}).then(r => setChecks(c => ({ ...c, [key]: r }))).catch(e => setChecks(c => ({ ...c, [key]: { ok: false, error: e.message } })));
  };
  const checkModels = () => {
    for (const role of ["main", "second"] as const) setChecks(c => ({ ...c, [role]: "pending" }));
    api<{ main: CheckResult; second: CheckResult }>("/api/models/check", {})
      .then(r => setChecks(c => ({ ...c, main: r.main, second: r.second })))
      .catch(e => setChecks(c => ({ ...c, main: { ok: false, error: e.message }, second: { ok: false, error: e.message } })));
  };
  const reachable = state.targets.filter(t => t.kind === "http" && t.ready);

  // The service counts a source's criteria from the log audit (api.source_summary): before the audit every source has none.
  const audited = !!state.discover;
  const totalRules = state.sources.reduce((n, src) => n + src.rules, 0);
  const kinds = Object.keys(SOURCE).map(kind => ({ kind, rules: state.sources.filter(s => s.kind === kind).reduce((n, s) => n + s.rules, 0) })).filter(k => k.rules > 0);
  const logsDone = setupSteps(state)[1].done;
  const collect = (
    <Button variant={state.sources.length ? "secondary" : "primary"} icon={Bot} disabled={state.job.running || !saved.repo} onClick={() => api("/api/sources", {}).catch(error)}
      title={!saved.repo ? "Сначала укажите код агента" : "Прочитать промпты, инструменты и базу знаний из кода агента"}>
      {state.sources.length ? "Собрать заново" : "Собрать из кода"}
    </Button>
  );

  return (
    <Page title="Подготовка" icon={SlidersHorizontal} bare nav={<SetupSteps state={state} current="agent" />} primary={collect} narrow>
      <header className="pt-10">
        <Label>Шаг 1 · агент</Label>
        <h2 className="mt-3 text-balance text-display font-medium text-lab-ink">
          {state.sources.length ? `${count(state.sources.length, "источник", "источника", "источников")} из кода агента.` : "Подключите агента."}
        </h2>
        <p className="mt-2 max-w-[680px] text-pretty text-lead text-lab-soft">
          {!state.sources.length ? "Укажите адрес агента и его репозиторий: из кода берутся промпты, инструменты и база знаний."
            : audited ? `Оценка логов выделила из них ${count(totalRules, "критерий", "критерия", "критериев")}, у каждого есть цитата-первоисточник.`
              : "Критерии из них выделит оценка логов — следующий шаг."}
        </p>
        <div className="mt-4"><JobLine state={state} kind="sources" /></div>
      </header>

      {state.sources.length > 0 ? (
        <Section title="Источники" count={state.sources.length}>
          {audited && (
            <Strip>
              <Stat label="Критериев" value={totalRules} sub={`из ${count(state.sources.length, "источника", "источников", "источников")}`} />
              {kinds.map(k => <Stat key={k.kind} label={SOURCE[k.kind].label} value={k.rules} sub={plural(k.rules, "критерий", "критерия", "критериев")} />)}
            </Strip>
          )}
          <div className={cn("divide-y divide-lab-line rounded-lg border border-lab-line bg-lab-panel", audited && "mt-3")}>
            {state.sources.map(src => {
              const meta = SOURCE[src.kind] ?? { label: src.kind, icon: BookOpen };
              return (
                <div key={src.id} className="flex items-center gap-3 px-4 py-2.5">
                  <meta.icon className="size-4 flex-shrink-0 text-lab-mute" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-caption text-lab-text" title={src.origin}>{src.origin}</div>
                    <div className="text-caption text-lab-mute">{meta.label} · {thousands(src.chars)}</div>
                  </div>
                  {audited && <span className="flex-shrink-0 text-body tabular-nums text-lab-soft">{src.rules ? count(src.rules, "критерий", "критерия", "критериев") : "без критериев"}</span>}
                </div>
              );
            })}
          </div>
        </Section>
      ) : (
        <EmptyState icon={Bot} title="Критерии ещё не собраны">Укажите репозиторий с кодом агента и нажмите «Собрать из кода»: из промптов и инструментов выделятся критерии, у каждого — цитата.</EmptyState>
      )}

      <Section title="Подключение" hint="хранится только на этом компьютере">
        <div className="rounded-lg border border-lab-line bg-lab-panel">
          <div className="space-y-5 p-5">
            <Field label="Адрес агента на тестовом стенде" hint="HTTP-ручка агента на ИФТ, доступная из сети банка.">
              <Input mono value={form.prodUrl} onChange={e => setForm({ ...form, prodUrl: e.target.value })} placeholder="http://…/api/v1/ai/agents/…" />
            </Field>
            <div>
              <div className="mb-1.5 text-body font-medium text-lab-text">EPK клиентов</div>
              <TagInput label="EPK клиентов" value={form.epk} onChange={epk => setForm({ ...form, epk })} placeholder="Введите EPK и нажмите Enter" />
              <div className="mt-1.5 text-caption text-lab-mute">Агент увидит данные этих организаций. Без EPK клиент будет неавторизованным.</div>
            </div>
            <Field label="Код агента" hint="Репозиторий, откуда берутся промпты, инструменты и база знаний.">
              <Input mono value={form.repo} onChange={e => setForm({ ...form, repo: e.target.value })} placeholder="~/Desktop/aigw-local" />
            </Field>
          </div>
          <div className="flex items-center gap-2 border-t border-lab-line px-5 py-3">
            <Button variant={dirty ? "primary" : "secondary"} disabled={!dirty} onClick={save}>Сохранить</Button>
            {dirty && <Button variant="ghost" onClick={() => setForm(base)}>Отменить</Button>}
            <span className={cn("ml-auto inline-flex items-center gap-1.5 text-caption", dirty ? "text-lab-warn" : "text-lab-mute")}>
              {dirty ? <><span className="size-1.5 rounded-full bg-lab-warn" />Есть несохранённые изменения</> : <><Check className="size-3.5" />Сохранено</>}
            </span>
          </div>
        </div>
      </Section>

      <Section title="Агенты" count={state.targets.length} hint="с кем можно проверить версию"
        right={reachable.length > 1 ? <Button size="sm" onClick={() => reachable.forEach(t => check(t.id, `/api/agents/${t.id}/check`))}>Проверить связь со всеми</Button> : undefined}>
        <div className="divide-y divide-lab-line rounded-lg border border-lab-line bg-lab-panel">
          {state.targets.map(t => {
            const Icon = t.kind === "code" ? Code : Globe;
            return (
              <div key={t.id} className="px-4 py-3.5">
                <div className="flex items-start gap-3">
                  <Icon className="mt-0.5 size-4 flex-shrink-0 text-lab-mute" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-body font-medium text-lab-ink">{t.name}</span>
                      <span className="lab-label text-lab-faint">{t.kind === "code" ? "из кода" : "по HTTP"}</span>
                    </div>
                    <div className="mt-0.5 truncate font-mono text-caption text-lab-mute" title={t.where}>{t.where || "адрес не задан"}</div>
                    <div className="mt-1 text-body text-lab-soft">{t.note}</div>
                    <VerdictDetail check={checks[t.id]} />
                  </div>
                  <div className="flex flex-shrink-0 flex-col items-end gap-2">
                    {!t.ready ? <Badge hue="warn">не настроен</Badge> : <Verdict check={checks[t.id]} />}
                    {t.kind === "http" && t.ready && checks[t.id] !== "pending" && (
                      <Button size="sm" onClick={() => check(t.id, `/api/agents/${t.id}/check`)}>{checks[t.id] ? "Ещё раз" : "Проверить связь"}</Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Модели" hint={`запросы идут через ${state.models.via}`} right={<Button size="sm" icon={ShieldCheck} onClick={checkModels}>Проверить</Button>}>
        <div className="divide-y divide-lab-line rounded-lg border border-lab-line bg-lab-panel">
          {([["main", "Судья и клиент", "оценивает диалоги и пишет реплики клиента", state.models.main], ["second", "Второй судья", "модель другого вендора, перепроверяет вердикты", state.models.second]] as const).map(([key, role, sub, model]) => (
            <div key={key} className="px-4 py-3.5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="text-body font-medium text-lab-ink">{role}</div>
                  <div className="mt-0.5 text-caption text-lab-mute">{sub}</div>
                </div>
                <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                  <span className="font-mono text-caption text-lab-text">{model ?? "новейшая из каталога"}</span>
                  <Verdict check={checks[key]} />
                </div>
              </div>
              <VerdictDetail check={checks[key]} />
            </div>
          ))}
        </div>
        {state.models.via === "OpenRouter" && <p className="mt-2 text-caption text-lab-mute">Чтобы работать через шлюз банка, положите сертификаты в папку certs/.</p>}
      </Section>

      {state.sources.length > 0 && (
        <NextStep done={logsDone} title="Оцените реальные диалоги" hint="Загрузите выгрузку чата: судья проверит записанные разговоры по этим критериям." to="/lab/logs" cta={logsDone ? "К логам" : "Загрузить логи"} />
      )}
    </Page>
  );
}
