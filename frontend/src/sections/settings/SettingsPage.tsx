import { useState } from "react";
import { Check as CheckIcon, ShieldCheck } from "lucide-react";
import { Header } from "../../app/Header";
import { api } from "../../lab/api";
import type { LabState, Models as ModelsState, Probe } from "../../lab/types";
import { useLabState } from "../../lab/LabProvider";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { Group, Row } from "./parts";
import { SIMULATIONS } from "../../app/product";

/** Where the conversations go without the bank's gateway and an endpoint of one's own (backend/lab/models/__init__.py, _via). */
const OPENROUTER = "OpenRouter";
/** The bank's gateway, as the service names it where the conversations go through it (_via). */
const GATEWAY = "шлюз банка";

/** Where the conversations go, in words: OpenRouter, the bank's gateway, or a model's server, whose address is the developer's. */
const destination = (via: string) =>
  via === OPENROUTER ? "в OpenRouter" : via === GATEWAY ? "через шлюз банка" : "на отдельный сервер модели";

/**
 * «Настройки»: what the product itself runs on — the models, and what to do when they are not set up — in words a
 * person reads; addresses and commands for whoever starts the Lab stay folded at the end. How to reach the agent lives
 * in «Агент».
 */
export function SettingsPage() {
  const { state, offline } = useLabState();
  const models = state?.models;
  return (
    <div className="flex h-full flex-col">
      <Header title="Настройки" />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-6xl px-4 pb-16 lg:px-10">
          <Group title="Модели" about={models ? <Destination models={models} /> : undefined}>
            {state ? (
              <>
                {state.models.problem && <Problem models={state.models} />}
                <Models state={state} />
              </>
            ) : offline ? (
              <p className="text-small text-fg-2">Сервис не отвечает, поэтому моделей не видно.</p>
            ) : (
              <Skeleton className="h-28" />
            )}
          </Group>
          <ForDeveloper models={models} />
        </div>
      </div>
    </div>
  );
}

const Address = ({ children }: { children: string }) => (
  <span className="select-all break-all font-mono text-small text-fg-2">{children}</span>
);

/** Where the customers' conversations go, in words: through OpenRouter, the bank's gateway or a server of a model. */
function Destination({ models }: { models: ModelsState }) {
  return (
    <>
      Разговоры уходят {destination(models.via)}.
      {models.secondVia && <> Вторая проверка — {destination(models.secondVia)}.</>}
    </>
  );
}

/**
 * Why no check starts now, and what to do, in plain words. The key of OpenRouter is given when the Lab is started
 * (README), so whoever starts the Lab sets it; the bank's gateway, set up and broken, is told by the service's reason.
 */
function Problem({ models }: { models: ModelsState }) {
  // OpenRouter's one problem is the missing key; any other is the bank gateway's.
  const noKey = models.via === OPENROUTER;
  return (
    <div role="alert" className="mb-4 rounded-block border border-bad/30 bg-bad/[0.06] p-4">
      <p className="text-body font-medium text-bad">{noKey ? "Модели не настроены" : "Шлюз банка не работает"}</p>
      {noKey ? (
        <>
          <p className="mt-1 text-body text-fg-2">
            Проверки не запустятся, пока у Lab нет ключа OpenRouter. Ключ задаёт тот, кто запускает Lab, — вот так:
          </p>
          <code className="mt-2 block w-fit max-w-full select-all break-all rounded-control bg-canvas px-3 py-2 font-mono text-small text-fg">
            OPENROUTER_API_KEY=… sh bin/start.sh
          </code>
        </>
      ) : (
        <p className="mt-1 break-words text-body text-fg-2">
          Проверки не запустятся, пока шлюз не исправят. {models.problem}
        </p>
      )}
      <p className="mt-2 text-small text-fg-3">
        {noKey
          ? "Пока ключа нет, разговоры никуда не отправляются."
          : "Пока шлюз не исправлен, разговоры никуда не отправляются."}
      </p>
    </div>
  );
}

/**
 * What only a developer needs, folded under the models: where the Lab answers and how it is started, where the
 * conversations go by address, where the bank gateway's settings lie (LAB_CERTS, certs/ by default).
 */
function ForDeveloper({ models }: { models?: ModelsState }) {
  return (
    <details className="border-t border-line py-6 text-body">
      <summary className="w-fit cursor-pointer rounded-sm text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60">
        Для разработчика
      </summary>
      <div className="mt-4 max-w-3xl border-t border-line">
        <Row name="Адрес Lab" use="Данные, проверки и интерфейс — один процесс на этом компьютере.">
          <Address>{window.location.origin}</Address>
        </Row>
        <Row name="Как запустить Lab" use="Из папки Lab. Ключ и модель задаются в этой же команде, как в README.">
          <Address>sh bin/start.sh</Address>
        </Row>
        {models && (
          <Row
            name="Куда уходят разговоры"
            use={models.secondVia ? `Вторая проверка — ${models.secondVia}.` : undefined}
          >
            <Address>{models.via}</Address>
          </Row>
        )}
        <Row name="Настройки шлюза банка" use="Адрес шлюза и сертификаты, когда модели идут через шлюз банка.">
          <Address>certs/</Address>
        </Row>
      </div>
    </details>
  );
}

/**
 * Who judges and who plays the customer, and who judges again; «Проверить» asks each model once and says what it
 * answered. When the check itself fails, it says so under the button: that tells nothing about either model, and the
 * second may not exist at all.
 */
function Models({ state }: { state: LabState }) {
  const [checks, setChecks] = useState<{ main: Probe; second: Probe | null } | "pending" | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const check = () => {
    setChecks("pending");
    setFailed(null);
    api<{ main: Probe; second: Probe | null }>("/api/models/check", {})
      .then(setChecks)
      .catch((e) => {
        setChecks(null);
        setFailed(e instanceof Error ? e.message : String(e));
      });
  };
  const rows = [
    {
      role: "main" as const,
      name: "Основная модель",
      use: SIMULATIONS ? "Проверяет разговоры и играет клиента в симуляциях." : "Проверяет разговоры.",
      model: state.models.main,
    },
    // With one model there is no second check: asking the same model twice is not a second opinion.
    state.models.second
      ? {
          role: "second" as const,
          name: "Вторая проверка",
          use: "Модель другого вендора. Проверяет те же разговоры независимо от основной.",
          model: state.models.second,
        }
      : {
          role: "second" as const,
          name: "Вторая проверка",
          use: "Доступна одна модель, поэтому разговоры проверяет только она. Насколько ей можно верить, показывают ваши ответы «Да / Нет».",
          model: null,
          none: "нет",
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
                {r.model ?? <span className="font-sans text-fg-3">{"none" in r ? r.none : "не задана"}</span>}
              </span>
            </Row>
          );
        })}
      </div>
      <Button className="mt-4" icon={ShieldCheck} loading={checks === "pending"} onClick={check}>
        Проверить модели
      </Button>
      {failed && (
        <p role="alert" className="mt-2 break-words text-small text-fg-2">
          Не удалось проверить модели. {failed}
        </p>
      )}
    </>
  );
}
