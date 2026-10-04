import type { ReactNode } from "react";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { StageTabs } from "../../app/StageTabs";
import type { Check } from "../../app/links";
import { CHECK_NAME } from "../../lab/checks";
import { useLabState } from "../../lab/LabProvider";
import { useProblems } from "../../lab/problems";
import { proposingCheck } from "../../lab/severity";
import { queueOf } from "../../lab/verdicts";

/** The tasks a check's pages follow under their head: the check itself, and for tone of voice the criteria it collects. */
const TASKS: Record<Check, string[]> = { tone: ["tone-check", "tone-criteria"], code: ["discover"] };

/**
 * With them, the proposal of which errors are serious (lab/severity): of this check, when this tab started it; the
 * task does not say its check, so one started elsewhere shows in both.
 */
const tasksOf = (check: Check) => {
  const proposing = proposingCheck();
  return !proposing || proposing === check ? [...TASKS[check], "severity"] : TASKS[check];
};

/** The tabs of a check with their counts: every conversation its result judged, the cases where two checks disagree. */
function CheckTabs({ check }: { check: Check }) {
  const { state } = useLabState();
  const { data } = useProblems(check);
  return (
    <StageTabs
      stage={check}
      counts={{
        conversations: state?.checks[check]?.results.length,
        review: data?.log ? queueOf(data, "disputed", null, "log").length : undefined,
      }}
    />
  );
}

/** The head of every page of a check: its name, its tabs, the page's actions, and the check's own task while it runs. */
export function CheckHeader({ check, actions }: { check: Check; actions?: ReactNode }) {
  return (
    <Header
      title={CHECK_NAME[check]}
      tabs={<CheckTabs check={check} />}
      actions={actions}
      below={<SectionJob kinds={tasksOf(check)} />}
    />
  );
}
