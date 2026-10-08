import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Plus } from "lucide-react";
import { buttonClass } from "../../ui/Button";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { StageTabs } from "../../app/StageTabs";
import { launchLink, type Check } from "../../app/links";
import { CHECK_NAME } from "../../lab/checks";
import { useLabState } from "../../lab/LabProvider";
import type { Job } from "../../lab/types";
import { proposalCheck } from "../../lab/severity";

/** The tasks a check's pages follow under their head: the check itself, and for tone of voice the criteria it collects. */
const TASKS: Record<Check, string[]> = { tone: ["tone-check", "tone-criteria"], code: ["discover"] };

/** With them, the proposal of which errors are serious (lab/severity) of this check: its task says its check. */
const tasksOf = (check: Check, job: Job | undefined) => [
  ...TASKS[check],
  ...(proposalCheck(job) === check ? ["severity"] : []),
  ...(job?.kind === "launch" && job.input?.check === check ? ["launch"] : []),
];

/** The head of every page of a check: its name, its tabs, the page's actions, and the check's own task while it runs. */
export function CheckHeader({ check, actions }: { check: Check; actions?: ReactNode }) {
  const { state } = useLabState();
  return (
    <Header
      title={CHECK_NAME[check]}
      tabs={<StageTabs stage={check} />}
      actions={
        <>
          {actions}
          <Link to={launchLink(check)} className={buttonClass({ variant: "primary" })}>
            <Plus aria-hidden className="size-3.5" />
            Новая проверка
          </Link>
        </>
      }
      below={<SectionJob kinds={tasksOf(check, state?.job)} />}
    />
  );
}
