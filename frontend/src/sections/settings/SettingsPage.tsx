import { useState } from "react";
import { Check as CheckIcon, ShieldCheck } from "lucide-react";
import { Header } from "../../app/Header";
import { api } from "../../lab/api";
import type { Check, LabState } from "../../lab/types";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { Group, Row } from "./parts";

/** «Настройки»: what the product itself runs on — the models and where it answers. How to reach the agent lives in «Агент». */
export function SettingsPage() {
  const { state, offline } = useLabState();
  return (
    <div className="flex h-full flex-col">
      <Header title="Настройки" />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-6xl px-4 pb-16 lg:px-10">
          <Group
            title="Модели"
            about={
              state ? (
                <>
                  Запросы идут через {state.models.via}.
                  {state.models.via === "OpenRouter" && (
                    <>
                      {" "}
                      Сертификаты шлюза банка кладутся в папку <span className="font-mono">certs/</span>.
                    </>
                  )}
                </>
              ) : undefined
            }
          >
            {state ? (
              <Models state={state} />
            ) : offline ? (
              <p className="text-small text-fg-2">Сервис проверок не отвечает, модели сейчас не видны.</p>
            ) : (
              <Skeleton className="h-28" />
            )}
          </Group>
          <Group title="Где что работает">
            <div className="border-t border-line">
              <Row name="Agent Lab" use="Данные, проверки и этот интерфейс: один процесс на этом компьютере.">
                <Address>{window.location.origin}</Address>
              </Row>
              <Row name="Запуск" use="Поднимает продукт из его папки.">
                <Address>sh bin/start.sh</Address>
              </Row>
            </div>
          </Group>
        </div>
      </div>
    </div>
  );
}

const Address = ({ children }: { children: string }) => (
  <span className="select-all font-mono text-small text-fg-2">{children}</span>
);

/** Who judges and who plays the customer, and who judges again; «Проверить» asks each model once and says what it answered. */
function Models({ state }: { state: LabState }) {
  const [checks, setChecks] = useState<{ main: Check; second: Check } | "pending" | null>(null);
  const check = () => {
    setChecks("pending");
    api<{ main: Check; second: Check }>("/api/models/check", {})
      .then(setChecks)
      .catch((e) => {
        const failed = { ok: false, error: String(e?.message ?? e) };
        setChecks({ main: failed, second: failed });
      });
  };
  const rows = [
    {
      role: "main" as const,
      name: "Основная модель",
      use: "Проверяет разговоры и играет клиента в симуляциях.",
      model: state.models.main,
    },
    {
      role: "second" as const,
      name: "Вторая проверка",
      use: "Модель другого вендора: проверяет найденные ошибки независимо от первой.",
      model: state.models.second,
    },
  ];
  return (
    <>
      <div className="border-t border-line">
        {rows.map((r) => {
          const c = checks && checks !== "pending" ? checks[r.role] : null;
          return (
            <Row
              key={r.role}
              name={r.name}
              use={r.use}
              below={
                c &&
                !c.ok && (
                  <p role="alert" className="mt-1 break-words text-small text-fg-2">
                    {c.error ?? "Модель не ответила."}
                  </p>
                )
              }
            >
              {c?.ok && (
                <span className="inline-flex items-center gap-1 text-small text-ok">
                  <CheckIcon aria-hidden className="size-3.5" />
                  отвечает
                </span>
              )}
              {c && !c.ok && <span className="text-small text-bad">не отвечает</span>}
              <span className="font-mono text-small text-fg">
                {r.model ?? <span className="font-sans text-fg-3">не задана</span>}
              </span>
            </Row>
          );
        })}
      </div>
      <Button className="mt-4" icon={ShieldCheck} loading={checks === "pending"} onClick={check}>
        Проверить модели
      </Button>
    </>
  );
}
