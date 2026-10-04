import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, Check as CheckMark } from "lucide-react";
import { Mark } from "../../app/Mark";
import { SECTIONS, toneCheckLink, type Check } from "../../app/links";
import { count, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { codeSources, TONE_ID } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { UploadButton } from "../../product/UploadLogs";
import { Button, buttonClass } from "../../ui/Button";
import { SizePicker, useAssess, useSampleSize } from "./AssessSheet";
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
      { label: "Правила общения", value: policy?.origin ?? null, later: "добавите на первом шаге" },
      ...(criteria
        ? [{ label: "Критерии", value: count(criteria, "критерий", "критерия", "критериев"), later: "" }]
        : []),
    ];
  }
  const code = codeSources(state).length;
  return [
    dialogs,
    {
      label: "Код агента",
      value: code ? count(code, "источник", "источника", "источников") : null,
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
        title="Идёт проверка tone of voice"
        action={
          <Link to={toneCheckLink("checking")} className={primary}>
            Ход проверки
            <ArrowRight aria-hidden className="size-4" />
          </Link>
        }
      >
        Итог появится здесь, когда модель проверит разговоры. Страницу можно закрыть: результат сохранится.
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
        <p className="mt-2">Проверьте новые разговоры по тем же критериям — итог сравнится с прошлой проверкой.</p>
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
      Загрузите выгрузку чата и правила общения: из правил соберём критерии, проверим по ним настоящие разговоры и
      покажем, где агент говорит не так, как договорились. Подключение к агенту не нужно.
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
  const { sizes, size, setSize } = useSampleSize();
  const { start, starting } = useAssess();
  const job = state?.job;
  if (job?.running && job.kind === "discover")
    return (
      <Empty title="Идёт оценка точности">
        Модель извлекает критерии из кода агента и проверяет по ним разговоры. Итог появится здесь; страницу можно
        закрыть.
      </Empty>
    );
  const code = codeSources(state).length;
  if (!code)
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
        Критерии точности — дословные требования из промптов и инструментов агента: делает ли он то, что они велят, и
        ничего не выдумывает. Укажите папку с кодом агента в «Агенте» и прочитайте его.
      </Empty>
    );
  const total = state?.logs.total ?? 0;
  if (!total)
    return (
      <Empty title="Загрузите разговоры" needs={needsOf("code", state)} action={<UploadButton check="code" />}>
        Код агента прочитан. Точность проверяют на настоящих разговорах клиентов из выгрузки чата.
      </Empty>
    );
  const busy = !!job?.running;
  return (
    <Empty
      title={previous?.newExport ? "Новая выгрузка ещё не проверена" : "Оценить точность"}
      needs={needsOf("code", state)}
      action={
        <div className="space-y-6">
          <SizePicker sizes={sizes} size={size} onSize={setSize} />
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
            Модель проверит новые разговоры по критериям из кода агента и, если критерии те же, сравнит итог с прошлой
            проверкой. Сам агент не запускается, итог tone of voice не меняется.
          </p>
        </>
      ) : (
        <>
          Модель извлечёт критерии из кода агента и по каждому отметит в разговоре: ошибка, без ошибки или не ясно. Сам
          агент не запускается, итог tone of voice не меняется.
          {previous && <PreviousCheck check="code" line={previous.line} className="mt-3" />}
        </>
      )}
    </Empty>
  );
}
