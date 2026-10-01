import { useState } from "react";
import { Check as CheckIcon, MessageSquare, ShieldCheck } from "lucide-react";
import { Header } from "../../app/Header";
import { api, API } from "../../lab/api";
import type { Check, LabState } from "../../lab/types";
import { useLabState } from "../../shell/LabProvider";
import { useShell } from "../../shell/ShellContext";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { Keys } from "./Keys";
import { Group, Row } from "./parts";
import { Replay } from "./Replay";

/** «Настройки»: what the product itself runs on — the models, the keys, the assistant, trace replay, where it answers. How to reach the agent lives in «Агент». */
export function SettingsPage() {
  const { state, offline } = useLabState();
  return (
    <div className="flex h-full flex-col">
      <Header title="Настройки" />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-6xl px-4 pb-16 lg:px-10">
          <Group title="Модели" about={state ? <>Запросы идут через {state.models.via}.{state.models.via === "OpenRouter" && <> Сертификаты шлюза банка кладутся в папку <span className="font-mono">certs/</span>.</>}</> : undefined}>
            {state ? <Models state={state} /> : offline ? <p className="text-small text-fg-2">Сервис проверок не отвечает, модели сейчас не видны.</p> : <Skeleton className="h-28" />}
          </Group>
          <Group title="Ключи" about="Для повтора трейсов и ассистента. Ключ один раз передаётся локальному Workshop и не возвращается в браузер.">
            <Keys />
          </Group>
          <Group title="Ассистент" about="«Спросить» (⌘J) отвечает через Claude Code или Codex на этом компьютере.">
            <Assistant />
          </Group>
          <Group title="Повтор трейсов" about="Адреса агентов на этом компьютере: по ним трейс повторяется с настоящими инструментами. В повторе появится режим «Локальный агент».">
            <Replay />
          </Group>
          <Group title="Где что работает">
            <div className="border-t border-line">
              <Row name="Сервис проверок" use="Оценка, критерии, симуляции."><Address>{API}</Address></Row>
              <Row name="Workshop" use="Трейсы, повтор, ассистент."><Address>{window.location.origin}</Address></Row>
              <Row name="Запуск" use="Поднимает оба из папки продукта."><Address>sh bin/start.sh</Address></Row>
            </div>
          </Group>
        </div>
      </div>
    </div>
  );
}

const Address = ({ children }: { children: string }) => <span className="select-all font-mono text-small text-fg-2">{children}</span>;

/** Who judges and who plays the customer, and who judges again; «Проверить» asks each model once and says what it answered. */
function Models({ state }: { state: LabState }) {
  const [checks, setChecks] = useState<{ main: Check; second: Check } | "pending" | null>(null);
  const check = () => {
    setChecks("pending");
    api<{ main: Check; second: Check }>("/api/models/check", {})
      .then(setChecks)
      .catch(e => { const failed = { ok: false, error: String(e?.message ?? e) }; setChecks({ main: failed, second: failed }); });
  };
  const rows = [
    { role: "main" as const, name: "Судья и клиент", use: "Оценивает диалоги и играет клиента в симуляциях.", model: state.models.main },
    { role: "second" as const, name: "Второй судья", use: "Модель другого вендора, проверяет вердикты первой.", model: state.models.second },
  ];
  return (
    <>
      <div className="border-t border-line">
        {rows.map(r => {
          const c = checks && checks !== "pending" ? checks[r.role] : null;
          return (
            <Row key={r.role} name={r.name} use={r.use} below={c && !c.ok && <p role="alert" className="mt-1 break-words text-meta text-fg-2">{c.error ?? "Модель не ответила."}</p>}>
              {c?.ok && <span className="inline-flex items-center gap-1 text-meta text-ok"><CheckIcon aria-hidden className="size-3.5" />отвечает</span>}
              {c && !c.ok && <span className="text-meta text-bad">не отвечает</span>}
              <span className="font-mono text-small text-fg">{r.model ?? <span className="font-sans text-fg-3">не задана</span>}</span>
            </Row>
          );
        })}
      </div>
      <Button className="mt-4" icon={ShieldCheck} loading={checks === "pending"} onClick={check}>Проверить модели</Button>
    </>
  );
}

/** The assistant's choice between Claude Code and Codex is made once; this shows it again, in the assistant itself. */
function Assistant() {
  const shell = useShell();
  const again = () => {
    try { localStorage.removeItem("workshop:messagePane:providerIntroSeen"); } catch { /* private window: the choice shows anyway */ }
    window.dispatchEvent(new CustomEvent("workshop:messagePane:resetOnboarding"));
    shell.openAsk();
  };
  return (
    <div className="border-t border-line">
      <Row name="Выбор ассистента" use="Сделан при первом вопросе; его можно сделать заново.">
        <Button size="sm" icon={MessageSquare} onClick={again}>Выбрать заново</Button>
      </Row>
    </div>
  );
}
