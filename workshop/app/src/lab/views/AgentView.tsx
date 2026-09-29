import { useEffect, useState } from "react";
import { BookOpen, Bot, Check, CircleAlert, Code, Globe, Loader2, ShieldCheck, Wrench, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "../api";
import { count, plural, thousands } from "../format";
import { JobLine } from "../JobLine";
import { setupSteps } from "../nav";
import { NextStep, SetupSteps } from "../Setup";
import { TagInput } from "../TagInput";
import { useToast } from "../toast";
import type { Check as CheckResult, LabState } from "../types";
import { Badge, Button, EmptyState, Field, Input, Page, Panel, Row, Section, StackBar } from "../ui";

const SOURCE: Record<string, { label: string; icon: LucideIcon; tone: string }> = {
  prompt: { label: "Промпт", icon: Bot, tone: "bg-lab-ink/70" },
  tools: { label: "Инструменты", icon: Wrench, tone: "bg-lab-mute" },
  knowledge: { label: "База знаний", icon: BookOpen, tone: "bg-lab-faint" },
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

  const withRules = state.sources.filter(src => src.rules > 0 || src.kind !== "prompt");
  const hidden = state.sources.length - withRules.length;
  const totalRules = withRules.reduce((n, src) => n + src.rules, 0);
  const kinds = Object.keys(SOURCE).map(kind => ({ kind, rules: withRules.filter(s => s.kind === kind).reduce((n, s) => n + s.rules, 0) })).filter(k => k.rules > 0);
  const logsDone = setupSteps(state)[1].done;
  const lede = state.sources.length
    ? `Агент подключён: ${count(totalRules, "критерий", "критерия", "критериев")} из ${count(withRules.length, "источника", "источников", "источников")} — промптов, инструментов и базы знаний.`
    : saved.repo ? "Код агента указан, но критерии ещё не собраны: нажмите «Собрать из кода»." : "Агент не подключён. Укажите адрес агента и репозиторий с его кодом: из промптов и инструментов получатся критерии.";

  return (
    <Page title="Агент" bare wide nav={<SetupSteps state={state} current="agent" />} lede={lede}>
      <div className="grid gap-x-8 min-[1240px]:grid-cols-2">
        <div className="min-w-0">
          <Section className="mt-8" title="Подключение" hint="Куда ходит симулятор клиента и откуда берётся код агента. Хранится только на этом компьютере.">
            <Panel>
              <div className="space-y-5 p-5">
                <Field label="Адрес агента на тестовом стенде" hint="HTTP-ручка агента на ИФТ, доступная из сети банка.">
                  <Input mono value={form.prodUrl} onChange={e => setForm({ ...form, prodUrl: e.target.value })} placeholder="http://…/api/v1/ai/agents/…" />
                </Field>
                <div>
                  <div className="mb-1.5 text-body font-medium text-lab-ink">EPK клиентов</div>
                  <TagInput label="EPK клиентов" value={form.epk} onChange={epk => setForm({ ...form, epk })} placeholder="Введите EPK и нажмите Enter" />
                  <div className="mt-1.5 text-caption text-lab-mute">Агент увидит данные этих организаций. Без EPK клиент будет неавторизованным.</div>
                </div>
                <Field label="Код агента" hint="Репозиторий, откуда берутся промпты, инструменты и база знаний.">
                  <Input mono value={form.repo} onChange={e => setForm({ ...form, repo: e.target.value })} placeholder="~/Desktop/aigw-local" />
                </Field>
              </div>
              <Row className="flex items-center gap-2 px-5 py-3.5">
                <Button variant="primary" disabled={!dirty} onClick={save}>Сохранить</Button>
                {dirty && <Button variant="ghost" onClick={() => setForm(base)}>Отменить</Button>}
                <span className={cn("ml-auto inline-flex items-center gap-1.5 text-body", dirty ? "text-lab-warn" : "text-lab-mute")}>
                  {dirty ? <><span className="size-1.5 rounded-full bg-lab-warn" />Есть несохранённые изменения</> : <><Check className="size-3.5" />Сохранено</>}
                </span>
              </Row>
            </Panel>
          </Section>

          <Section title="Модели" hint="Судья оценивает диалоги и играет клиента; второй судья независимо перепроверяет" right={<Button size="sm" icon={ShieldCheck} onClick={checkModels}>Проверить</Button>}>
            <Panel>
              {([["main", "Судья и клиент", "оценивает диалоги и пишет реплики клиента", state.models.main], ["second", "Второй судья", "модель другого вендора, перепроверяет вердикты", state.models.second]] as const).map(([key, role, sub, model], i) => (
                <Row first={!i} key={key} className="px-5 py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-body font-medium text-lab-ink">{role}</div>
                      <div className="mt-0.5 text-body text-lab-mute">{sub}</div>
                    </div>
                    <div className="flex flex-shrink-0 flex-col items-end gap-1.5">
                      <span className="rounded-md bg-lab-raised px-2 py-0.5 font-mono text-caption text-lab-text">{model ?? "новейшая из каталога"}</span>
                      <Verdict check={checks[key]} />
                    </div>
                  </div>
                  <VerdictDetail check={checks[key]} />
                </Row>
              ))}
              <Row className="px-5 py-3 text-body text-lab-mute">
                Запросы идут через {state.models.via}.{state.models.via === "OpenRouter" ? " Чтобы работать через шлюз банка, положите сертификаты в папку certs/." : ""}
              </Row>
            </Panel>
          </Section>
        </div>

        <div className="min-w-0">
          <Section
            className="min-[1240px]:mt-8" title="Агенты" hint="С кем можно провести проверку версии"
            right={reachable.length > 1 ? <Button size="sm" onClick={() => reachable.forEach(t => check(t.id, `/api/agents/${t.id}/check`))}>Проверить все</Button> : undefined}
          >
            <Panel>
              {state.targets.map((t, i) => {
                const Icon = t.kind === "code" ? Code : Globe;
                return (
                  <Row first={!i} key={t.id} className="px-5 py-4">
                    <div className="flex items-start gap-3.5">
                      <span className="mt-0.5 flex size-8 flex-shrink-0 items-center justify-center rounded-lg bg-lab-raised text-lab-mute"><Icon className="size-4" /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-body font-semibold text-lab-ink">{t.name}</span>
                          <Badge>{t.kind === "code" ? "из кода" : "по HTTP"}</Badge>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-caption text-lab-mute" title={t.where}>{t.where || "адрес не задан"}</div>
                        <div className="mt-1.5 text-body text-lab-text">{t.note}</div>
                        <VerdictDetail check={checks[t.id]} />
                      </div>
                      <div className="flex flex-shrink-0 flex-col items-end gap-2">
                        {!t.ready ? <Badge hue="warn">не настроен</Badge> : <Verdict check={checks[t.id]} />}
                        {t.kind === "http" && t.ready && checks[t.id] !== "pending" && (
                          <Button size="sm" onClick={() => check(t.id, `/api/agents/${t.id}/check`)}>{checks[t.id] ? "Ещё раз" : "Проверить связь"}</Button>
                        )}
                      </div>
                    </div>
                  </Row>
                );
              })}
            </Panel>
          </Section>

          <Section
            title="Источники критериев" hint="Из промптов, инструментов и базы знаний выделяются критерии, по которым судья проверяет диалоги"
            right={<>
              <JobLine state={state} kind="sources" bare />
              <Button size="sm" variant={state.sources.length ? "secondary" : "primary"} icon={Bot} disabled={state.job.running || !saved.repo} onClick={() => api("/api/sources", {}).catch(error)}
                title={!saved.repo ? "Сначала укажите код агента" : undefined}>
                {state.sources.length ? "Собрать заново" : "Собрать из кода"}
              </Button>
            </>}
          >
            {state.sources.length > 0 ? (
              <Panel>
                <div className="px-5 pb-4 pt-4">
                  <div className="flex items-baseline gap-2">
                    <span className="text-metric font-semibold tabular-nums text-lab-ink">{totalRules}</span>
                    <span className="text-body text-lab-mute">{plural(totalRules, "критерий", "критерия", "критериев")} из {count(withRules.length, "источника", "источников", "источников")}</span>
                  </div>
                  <StackBar className="mt-3" parts={kinds.map(k => ({ value: k.rules, tone: SOURCE[k.kind].tone }))} />
                  <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
                    {kinds.map(k => (
                      <span key={k.kind} className="inline-flex items-center gap-1.5 text-caption text-lab-mute">
                        <span className={cn("size-2 rounded-full", SOURCE[k.kind].tone)} />{SOURCE[k.kind].label} · <span className="tabular-nums">{k.rules}</span>
                      </span>
                    ))}
                  </div>
                </div>
                {withRules.map(src => {
                  const meta = SOURCE[src.kind] ?? { label: src.kind, icon: BookOpen, tone: "" };
                  return (
                    <Row key={src.id} className="flex items-center gap-3 px-5 py-2.5">
                      <meta.icon className="size-4 flex-shrink-0 text-lab-mute" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-mono text-caption text-lab-text" title={src.origin}>{src.origin}</div>
                        <div className="text-caption text-lab-mute">{meta.label} · {thousands(src.chars)}</div>
                      </div>
                      <span className="flex-shrink-0 text-body tabular-nums text-lab-ink">{count(src.rules, "критерий", "критерия", "критериев")}</span>
                    </Row>
                  );
                })}
                {hidden > 0 && <Row className="px-5 py-2.5 text-caption text-lab-mute">Ещё {count(hidden, "промпт", "промпта", "промптов")} без критериев скрыто: это классификаторы маршрутизации.</Row>}
              </Panel>
            ) : (
              <EmptyState icon={Bot} title="Критерии ещё не собраны">Укажите репозиторий с кодом агента и нажмите «Собрать из кода». Из промптов и инструментов выделятся критерии проверки, у каждого — цитата-первоисточник.</EmptyState>
            )}
          </Section>
        </div>
      </div>
      {state.sources.length > 0 && (
        <NextStep done={logsDone} title="Оцените реальные диалоги" hint="Загрузите выгрузку чата: судья проверит записанные разговоры по этим критериям." to="/lab/logs" cta={logsDone ? "К логам" : "Загрузить логи"} />
      )}
    </Page>
  );
}
