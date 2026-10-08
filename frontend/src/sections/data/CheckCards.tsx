import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { criterionLink, launchLink, SECTIONS, type Check } from "../../app/links";
import type { CheckLine } from "../../lab/agents";
import { CHECK_NAME, CHECKS } from "../../lab/checks";
import { useJudges } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import { codeSources } from "../../lab/tone";
import { CheckResult } from "../../product/CheckResult";
import { AccuracyPicture, PAPER, TonePicture } from "../../product/Pictures";
import { buttonClass } from "../../ui/Button";

/** What each check looks for, in the line a card has room for. */
const ABOUT: Record<Check, string> = {
  tone: "Соблюдает ли агент правила общения банка: тон, обращение, ясность.",
  code: "Отвечает ли агент по своей базе знаний и инструкциям, ничего не выдумывая.",
};

/** What a check found in a dataset, and where its result opens. */
export type Found = { check: Check; line: CheckLine; to: string };

/** What a check lacks before it can run, and where that is added. */
type Need = { text: string; label: string; to: string };

const NEED: Record<Check, Need> = {
  tone: {
    text: "Сначала нужны правила общения: критерии соберутся из документа банка.",
    label: "Добавить правила",
    to: criterionLink("tone"),
  },
  code: {
    text: "Сначала нужен код агента: критерии соберутся из его инструкций.",
    label: "Подключить код агента",
    to: `${SECTIONS.agent}?return=code`,
  },
};

/**
 * One check of the dataset as a card: a picture of what it looks at, then what it found (the agents' result line) and
 * «Открыть итог», or what it checks and the way to begin — or, while its rules or the agent's code are missing, the
 * way to them. `main` — the screen's next step: the one black button.
 */
function CheckCard({
  check,
  found,
  need,
  datasetId,
  archived,
  main,
}: {
  check: Check;
  found?: Found;
  need: Need | null;
  datasetId: string;
  archived: boolean;
  main: boolean;
}) {
  const launch = `${launchLink(check)}?dataset=${encodeURIComponent(datasetId)}`;
  const button = (text: ReactNode, to: string) => (
    <Link to={to} className={buttonClass({ variant: main ? "primary" : "outline", size: "sm" })}>
      {text}
    </Link>
  );
  return (
    <section aria-label={CHECK_NAME[check]} className="flex gap-4 rounded-block border border-line bg-canvas p-3 pr-4">
      <div aria-hidden className={cn("hidden w-28 shrink-0 sm:block", PAPER)}>
        {check === "tone" ? <TonePicture /> : <AccuracyPicture />}
      </div>
      <div className="min-w-0 flex-1 py-1">
        {found ? (
          <>
            <CheckResult name={CHECK_NAME[check]} line={found.line} />
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              {button("Открыть итог", found.to)}
              {!archived && (
                <Link
                  to={launch}
                  className="rounded-sm text-small font-medium text-run hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
                >
                  Проверить снова
                </Link>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="text-small font-medium text-fg-2">{CHECK_NAME[check]}</p>
            <p className="mt-1 text-body text-fg-3">{need && !archived ? need.text : ABOUT[check]}</p>
            {!archived && (
              <div className="mt-3">
                {need
                  ? button(need.label, need.to)
                  : button(
                      <>
                        <Play aria-hidden className="size-3.5" />
                        Начать проверку
                      </>,
                      launch,
                    )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The checks of a dataset, a card each. The first check not done yet is the next step: its button is the screen's one
 * black button; a check done is opened, not called for. What a check lacks is said as the launch form says it.
 */
export function CheckCards({ found, datasetId, archived }: { found: Found[]; datasetId: string; archived: boolean }) {
  const { state } = useLabState();
  const judges = { tone: useJudges("tone"), code: useJudges("code") };
  // Ready as «Новая проверка» counts it: the chosen rules have criteria, or Точность reads them from the agent's code.
  // Until the rules come, a check is taken for ready: the form says what is missing anyway.
  const needOf = (check: Check): Need | null => {
    const data = judges[check].data;
    if (!data) return null;
    const rules = data.versions.find((v) => v.id === data.selectedId);
    const ready = rules ? rules.criteria.length > 0 : check === "code" && codeSources(state).length > 0;
    return ready ? null : NEED[check];
  };
  const next = archived ? undefined : CHECKS.find((check) => !found.some((f) => f.check === check));
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {CHECKS.map((check) => (
        <CheckCard
          key={check}
          check={check}
          found={found.find((f) => f.check === check)}
          need={needOf(check)}
          datasetId={datasetId}
          archived={archived}
          main={check === next}
        />
      ))}
    </div>
  );
}
