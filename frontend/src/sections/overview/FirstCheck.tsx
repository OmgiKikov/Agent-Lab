import { Link } from "react-router-dom";
import { ArrowRight, Check, Database, FlaskConical, MessageSquareQuote, Target } from "lucide-react";
import { criterionLink, SECTIONS, launchLink } from "../../app/links";
import { count } from "../../lab/format";
import { codeSources, customAccuracy, TONE_ID } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { UploadButton } from "../../product/UploadLogs";
import { buttonClass } from "../../ui/Button";

/** Shared data first; two independent checks next. Live trials stay a later step, after there is evidence. */
export function FirstCheck({ state }: { state: LabState }) {
  const loaded = state.logs.total > 0;
  const policy = state.sources.find((source) => source.id === TONE_ID);
  const code = codeSources(state);
  const custom = customAccuracy(state);
  const cards = [
    {
      title: "Tone of voice",
      icon: MessageSquareQuote,
      description: "Соблюдает ли агент правила общения: тон, обращение и ясность ответа.",
      ready: !!policy && !!state.toneOfVoice,
      need: policy ? policy.origin : "Нужны правила общения — текст или документ",
      // Without rules the first step is the rules themselves, given on «Критерии»: the bank's document, its criteria collected.
      to: policy && state.toneOfVoice ? launchLink("tone") : criterionLink("tone"),
      action: policy && state.toneOfVoice ? "К проверке" : "Добавить правила",
    },
    {
      title: "Точность",
      icon: Target,
      description: "Следует ли агент своим инструкциям и корректно ли использует инструменты.",
      ready: !!custom || code.length > 0,
      need: custom
        ? `Правила: ${custom.origin}`
        : code.length
          ? `Код прочитан · ${count(code.length, "источник", "источника", "источников")}`
          : "Выберите набор правил или прочитайте код агента",
      to: launchLink("code"),
      action: custom || code.length ? "К проверке" : "Настроить проверку",
    },
  ];
  return (
    <div className="mt-8">
      <section
        aria-labelledby="first-data"
        className="grid grid-cols-[40px_minmax(0,1fr)] items-center gap-4 rounded-block border border-line bg-inset/50 p-5 sm:grid-cols-[40px_minmax(0,1fr)_auto] sm:p-6"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-control bg-canvas text-fg-2">
          {loaded ? <Check aria-hidden className="size-5 text-ok" /> : <Database aria-hidden className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <h3 id="first-data" className="text-read font-semibold text-fg">
            {loaded ? "Диалоги загружены" : "1. Загрузите диалоги"}
          </h3>
          <p className="mt-1 break-words text-body text-fg-3">
            {loaded
              ? `${count(state.logs.total, "разговор", "разговора", "разговоров")}${state.logs.file ? ` · ${state.logs.file}` : ""}`
              : "Одна выгрузка чата для обеих проверок. XLSX, JSONL, JSON или CSV."}
          </p>
        </div>
        <div className="col-span-2 sm:col-span-1">
          {loaded ? (
            <Link to={SECTIONS.data} className={buttonClass({ variant: "outline" })}>
              Посмотреть диалоги
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          ) : (
            <UploadButton />
          )}
        </div>
      </section>
      <div className="mb-4 mt-8">
        <h3 className="text-read font-semibold text-fg">{loaded ? "Что проверим?" : "2. Выберите, что проверить"}</h3>
        <p className="mt-1 text-body text-fg-3">Можно начать с любой проверки. Подключать агента к стенду не нужно.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {cards.map(({ title, icon: Icon, description, ready, need, to, action }) => (
          <section key={title} className="flex min-w-0 flex-col rounded-block border border-line p-5 sm:p-6">
            <div className="flex items-center gap-2.5">
              <Icon aria-hidden className="size-5 text-fg-3" />
              <h4 className="text-count font-semibold text-fg">{title}</h4>
            </div>
            <p className="mt-3 max-w-[42ch] text-body text-fg-2">{description}</p>
            <p className="mt-5 flex items-start gap-2 border-t border-line pt-4 text-small text-fg-3">
              {ready ? (
                <Check aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
              ) : (
                <span aria-hidden className="mt-1 size-3 shrink-0 rounded-full border border-fg-4" />
              )}
              <span className="min-w-0 break-words">{need}</span>
            </p>
            <div className="mt-auto pt-5">
              <Link to={to} className={buttonClass({ variant: "outline" })}>
                {action}
                <ArrowRight aria-hidden className="size-3.5" />
              </Link>
            </div>
          </section>
        ))}
      </div>
      <div className="mt-6 flex items-start gap-3 rounded-block border border-dashed border-line-strong p-5">
        <FlaskConical aria-hidden className="mt-0.5 size-5 shrink-0 text-fg-3" />
        <div className="min-w-0">
          <h3 className="text-body font-medium text-fg">Потом — проверка в симуляциях</h3>
          <p className="mt-1 max-w-[75ch] text-small text-fg-3">
            Из найденных ошибок соберём сценарии. Синтетические клиенты проверят исправления на подключённом агенте.
          </p>
          <Link
            to={SECTIONS.simulations}
            className="mt-2 inline-flex items-center gap-1 text-small font-medium text-fg-2 hover:text-fg"
          >
            Как это работает
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      </div>
    </div>
  );
}
