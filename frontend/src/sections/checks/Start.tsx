import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check as CheckMark } from "lucide-react";
import { Mark } from "../../app/Mark";
import { launchLink, SECTIONS, type Check } from "../../app/links";
import { count } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { codeSources, customAccuracy, TONE_ID } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { UploadButton } from "../../product/UploadLogs";
import { buttonClass } from "../../ui/Button";
import { previousOf } from "../../lab/compare";
import { useDatasets } from "../../lab/datasets";
import { shownName } from "../data/DatasetInfo";
import { PreviousCheck, useComparison } from "./Compare";
import { PastCheck } from "./RunPage";

export type Need = { label: string; value: string | null; later: string };

/** What a check needs before it can be done: what is already here, or where it is added. */
export function needsOf(check: Check, state: LabState | null): Need[] {
  const total = state?.logs.total ?? 0;
  const dialogs = {
    label: "Разговоры",
    value: total ? count(total, "разговор", "разговора", "разговоров") : null,
    later: "выберите или загрузите датасет",
  };
  if (check === "tone") {
    const policy = state?.sources.find((s) => s.id === TONE_ID);
    // Criteria are collected from the rules on the second step, or come ready with rules taken from another agent.
    const criteria = state?.toneOfVoice?.criteria.length ?? 0;
    return [
      dialogs,
      { label: "Правила общения", value: policy?.origin ?? null, later: "выберите набор или добавьте документ" },
      ...(criteria
        ? [{ label: "Критерии", value: count(criteria, "критерий", "критерия", "критериев"), later: "" }]
        : []),
    ];
  }
  const code = codeSources(state).length;
  return [
    dialogs,
    {
      label: customAccuracy(state) ? "Правила судьи" : "Код агента",
      value: customAccuracy(state)?.origin ?? (code ? count(code, "источник", "источника", "источников") : null),
      later: "прочитайте код или выберите набор правил",
    },
  ];
}

/** The things a check needs as a list: a tick for what is here, an empty ring and where to add it for the rest. */
export function Needs({ needs, className }: { needs: Need[]; className?: string }) {
  return (
    <ul className={className}>
      {needs.map((n) => (
        <li key={n.label} className="flex items-start gap-2 py-1 text-body">
          {n.value ? (
            <CheckMark aria-label="есть" className="mt-0.5 size-4 flex-shrink-0 text-ok" />
          ) : (
            <span aria-label="нужно добавить" className="mt-1 size-3 flex-shrink-0 rounded-full border border-fg-4" />
          )}
          <span className="min-w-0">
            <span className="text-fg">{n.label}</span>
            <span className="text-fg-3"> · {n.value ?? n.later}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** An empty section: the quiet mark, what will be here, what it needs, and the one way forward. */
function Empty({
  title,
  children,
  needs,
  action,
}: {
  title: string;
  children: ReactNode;
  needs?: Need[];
  action?: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-14">
      <Mark quiet className="size-12 rounded-2xl" />
      <h2 className="mt-6 text-balance text-title font-semibold text-fg">{title}</h2>
      <div className="mt-2 max-w-[60ch] text-read text-fg-2">{children}</div>
      {needs && <Needs needs={needs} className="mt-5 border-t border-line pt-3" />}
      {action && <div className="mt-8">{action}</div>}
    </div>
  );
}

const primary = buttonClass({ variant: "primary", size: "lg" });

/** The last saved check of a check without a current result, and whether a new export came after it. */
function usePrevious(check: Check) {
  const { state } = useLabState();
  return previousOf(useComparison(check), state?.logs.updatedAt);
}

/**
 * Tone of voice before its result: the check under way; a new dataset not checked yet, with the previous check in full
 * under it — «Итог» never goes blank because new conversations came; the check begun, or how to begin it.
 */
export function ToneStart() {
  const { state } = useLabState();
  const previous = usePrevious("tone");
  const library = useDatasets();
  const fresh = library.data?.datasets.find((d) => d.id === library.data?.activeId);
  const job = state?.job;
  // A launch of this check is a check under way too: its report shows how far it got.
  const launch = job?.running && job.kind === "launch" && job.input?.check === "tone" ? job.progress.launch : null;
  // A launch that only asks the agent again makes no «Итог»: its answers are on its own page.
  const asking = !!launch && !job?.input?.modes?.includes("dataset");
  if (job?.running && (job.kind === "tone-check" || launch))
    return (
      <Empty
        title={asking ? "Задаём агенту вопросы клиентов" : "Проверяем разговоры"}
        action={
          <Link to={launch ? launchLink("tone", launch) : SECTIONS.tone} className={primary}>
            Открыть проверку
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        }
      >
        {asking
          ? "Новые ответы агента и их оценка будут на странице запуска. Итог проверки разговоров здесь не изменится."
          : "Итог появится здесь, когда модель проверит разговоры. Страницу можно закрыть, итог сохранится."}
      </Empty>
    );
  if (previous?.newExport)
    return (
      <PastCheck
        check="tone"
        id={previous.line.id}
        lead={
          <div className="flex max-w-[760px] flex-wrap items-center gap-x-4 gap-y-2 rounded-block bg-inset px-4 py-3">
            <p className="min-w-[min(100%,18rem)] flex-1 text-body text-fg-2">
              {fresh ? `Новый датасет «${shownName(fresh)}» ещё не проверен.` : "Новый датасет ещё не проверен."} Ниже —
              итог прошлой проверки.
            </p>
            <Link to={launchLink("tone")} className={buttonClass({ variant: "primary", size: "sm" })}>
              Проверить новый датасет
            </Link>
          </div>
        }
      />
    );
  return (
    <Empty
      title="Здесь появится итог tone of voice"
      needs={needsOf("tone", state)}
      action={
        <Link to={launchLink("tone")} className={primary}>
          Настроить проверку
          <ArrowRight aria-hidden className="size-4" />
        </Link>
      }
    >
      {needsOf("tone", state).every((need) => need.value)
        ? "Разговоры и критерии готовы. В «Новой проверке» выберите, сколько разговоров проверить и что именно."
        : "Загрузите датасет разговоров и правила общения. Из правил соберём критерии и проверим по ним настоящие разговоры. Подключать агента не нужно."}
      {previous && <PreviousCheck check="tone" line={previous.line} className="mt-3" />}
    </Empty>
  );
}

/**
 * Accuracy before its result: criteria can come from the agent's code or a rule set. Both paths lead to the shared
 * launch configuration; a previous check remains visible after a new dataset arrives.
 */
export function AccuracyStart() {
  const { state } = useLabState();
  const previous = usePrevious("code");
  const job = state?.job;
  if (job?.running && (job.kind === "discover" || (job.kind === "launch" && job.input?.check === "code")))
    return (
      <Empty title="Проверяем разговоры">
        Модель извлекает критерии из кода агента и проверяет по ним разговоры. Итог появится здесь, страницу можно
        закрыть.
      </Empty>
    );
  const code = codeSources(state).length;
  if (!code && !customAccuracy(state))
    return (
      <Empty
        title="Выберите правила проверки точности"
        needs={needsOf("code", state)}
        action={
          <Link to={launchLink("code")} className={primary}>
            Настроить проверку
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        }
      >
        Критерии можно извлечь из инструкций и инструментов агента или выбрать готовый набор правил.
      </Empty>
    );
  const total = state?.logs.total ?? 0;
  if (!total)
    return (
      <Empty title="Нужен датасет" needs={needsOf("code", state)} action={<UploadButton check="code" />}>
        Критерии точности готовы. Проверку проводят на настоящих разговорах клиентов из датасета.
      </Empty>
    );
  return (
    <Empty
      title={previous?.newExport ? "Новый датасет ещё не проверен" : "Здесь появится итог точности"}
      needs={needsOf("code", state)}
      action={
        <Link to={launchLink("code")} className={primary}>
          Настроить проверку
          <ArrowRight aria-hidden className="size-4" />
        </Link>
      }
    >
      {previous?.newExport ? (
        <>
          <PreviousCheck check="code" line={previous.line} />
          <p className="mt-2">
            Модель проверит новые разговоры по критериям из кода агента. Если критерии те же, итог сравнится с прошлой
            проверкой. Сам агент не запускается, итог tone of voice не изменится.
          </p>
        </>
      ) : (
        <>
          Модель проверит разговоры по выбранным критериям точности. Сам агент не запускается, итог tone of voice не
          изменится.
          {previous && <PreviousCheck check="code" line={previous.line} className="mt-3" />}
        </>
      )}
    </Empty>
  );
}
