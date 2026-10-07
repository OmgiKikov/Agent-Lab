import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check as CheckMark } from "lucide-react";
import { Mark } from "../../app/Mark";
import { SECTIONS, toneCheckLink, type Check } from "../../app/links";
import { count, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { codeSources, customAccuracy, TONE_ID } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { UploadButton } from "../../product/UploadLogs";
import { Button, buttonClass } from "../../ui/Button";
import { Resumes, SizePicker, useAssess, useSampleSize } from "./AssessSheet";
import { previousOf } from "../../lab/compare";
import { PreviousCheck, useComparison } from "./Compare";

export type Need = { label: string; value: string | null; later: string };

/** What a check needs before it can be done: what is already here, or where it is added. */
export function needsOf(check: Check, state: LabState | null): Need[] {
  const total = state?.logs.total ?? 0;
  const dialogs = {
    label: "Разговоры",
    value: total ? count(total, "разговор", "разговора", "разговоров") : null,
    later: check === "tone" ? "загрузите на первом шаге" : "загрузите выгрузку чата",
  };
  if (check === "tone") {
    const policy = state?.sources.find((s) => s.id === TONE_ID);
    // Criteria are collected from the rules on the second step, or come ready with rules taken from another agent.
    const criteria = state?.toneOfVoice?.criteria.length ?? 0;
    return [
      dialogs,
      { label: "Правила общения", value: policy?.origin ?? null, later: "добавьте на первом шаге" },
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
      later: "прочитайте в «Агенте»",
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
 * Tone of voice before its result: the check under way, a new export not checked yet beside the previous check, the
 * check begun, or how to begin it.
 */
export function ToneStart() {
  const { state } = useLabState();
  const previous = usePrevious("tone");
  const job = state?.job;
  if (job?.running && job.kind === "tone-check")
    return (
      <Empty
        title="Проверяем разговоры"
        action={
          <Link to={toneCheckLink("checking")} className={primary}>
            Открыть проверку
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        }
      >
        Итог появится здесь, когда модель проверит разговоры. Страницу можно закрыть, итог сохранится.
      </Empty>
    );
  if (previous?.newExport)
    return (
      <Empty
        title="Новая выгрузка ещё не проверена"
        needs={needsOf("tone", state)}
        action={
          <Link to={toneCheckLink()} className={primary}>
            Проверить новую выгрузку
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        }
      >
        <PreviousCheck check="tone" line={previous.line} />
        <p className="mt-2">Чтобы сравнить итог с прошлой проверкой, проверьте новые разговоры по тем же критериям.</p>
      </Empty>
    );
  const begun = !!state?.toneOfVoice || (!!job?.running && job.kind === "tone-criteria");
  return (
    <Empty
      title="Здесь появится итог tone of voice"
      needs={needsOf("tone", state)}
      action={
        <Link to={begun ? toneCheckLink() : toneCheckLink("materials")} className={primary}>
          {begun ? "Продолжить проверку" : "Начать проверку"}
          <ArrowRight aria-hidden className="size-4" />
        </Link>
      }
    >
      Загрузите выгрузку чата и правила общения. Из правил соберём критерии и проверим по ним настоящие разговоры.
      Подключать агента не нужно.
      {previous && <PreviousCheck check="tone" line={previous.line} className="mt-3" />}
    </Empty>
  );
}

/**
 * Accuracy before its result: the criteria come word for word from the agent's prompts and tools, so without its code
 * there is nothing to check by («Нужен код агента»); with the code, one button checks the conversations — after a new
 * export, beside the previous check.
 */
export function AccuracyStart() {
  const { state } = useLabState();
  const previous = usePrevious("code");
  const { sizes, size, setSize, resumes } = useSampleSize();
  const { start, starting } = useAssess();
  const job = state?.job;
  if (job?.running && job.kind === "discover")
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
        title="Нужен код агента"
        needs={needsOf("code", state)}
        action={
          <Link to={SECTIONS.agent} className={primary}>
            Прочитать код
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        }
      >
        Критерии точности берутся дословно из инструкций и инструментов агента. Укажите папку с его кодом в «Агенте» и
        прочитайте код.
      </Empty>
    );
  const total = state?.logs.total ?? 0;
  if (!total)
    return (
      <Empty title="Нужна выгрузка чата" needs={needsOf("code", state)} action={<UploadButton check="code" />}>
        Критерии точности готовы. Проверку проводят на настоящих разговорах клиентов из выгрузки.
      </Empty>
    );
  const busy = !!job?.running;
  return (
    <Empty
      title={previous?.newExport ? "Новая выгрузка ещё не проверена" : "Здесь появится итог точности"}
      needs={needsOf("code", state)}
      action={
        <div className="space-y-6">
          <SizePicker sizes={sizes} size={size} onSize={setSize} />
          <Resumes when={resumes} />
          <Button
            variant="primary"
            size="lg"
            loading={starting}
            disabled={busy || !size}
            title={busy ? "Сейчас идёт другая задача" : undefined}
            onClick={() => start(size, false)}
          >
            Оценить {size} {plural(size, "разговор", "разговора", "разговоров")}
          </Button>
        </div>
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
