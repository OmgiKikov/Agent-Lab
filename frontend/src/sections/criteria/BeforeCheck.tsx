import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BookOpen, Play } from "lucide-react";
import { launchLink, SECTIONS } from "../../app/links";
import { count } from "../../lab/format";
import type { JudgeVersion } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import { codeSources } from "../../lab/tone";
import { Button, buttonClass } from "../../ui/Button";

/**
 * «Критерии» of Точность before its first check: the criteria of a chosen rule set to read before anything is spent,
 * with «Новая проверка» as the next step; or that the criteria come from the agent's code at the first check, or where
 * that code is connected. Tone of voice has its own page before and after a check (ToneCriteria).
 */
export function BeforeCheck({
  rules,
  onRules,
}: {
  rules: JudgeVersion | null;
  /** Opens the rule sets: to change the criteria or take another set. */
  onRules: () => void;
}) {
  const { state } = useLabState();
  const code = codeSources(state).length > 0;
  const criteria = rules?.criteria ?? [];
  const launch = (
    <Link to={launchLink("code")} className={buttonClass({ variant: "primary" })}>
      <Play aria-hidden className="size-3.5" />
      Новая проверка
    </Link>
  );
  const rulesButton = (label: string) => (
    <Button icon={BookOpen} onClick={onRules}>
      {label}
    </Button>
  );
  let title: string;
  let lead: string;
  let actions: ReactNode;
  if (criteria.length) {
    title = `${count(criteria.length, "критерий", "критерия", "критериев")} из набора «${rules!.name}»`;
    lead = "Так мы поняли ваш набор правил. По этим критериям пойдёт проверка.";
    actions = (
      <>
        {launch}
        {rulesButton("Правила")}
      </>
    );
  } else if (code) {
    title = "Критерии соберутся из кода агента";
    lead =
      "При первой проверке модель прочитает инструкции и инструменты агента и разобьёт их по темам — критерии появятся здесь.";
    actions = (
      <>
        {launch}
        {rulesButton("Выбрать набор правил")}
      </>
    );
  } else {
    title = "Сначала нужен код агента";
    lead = "Из инструкций и инструментов агента соберутся критерии Точности. Или выберите готовый набор правил.";
    actions = (
      <>
        <Link to={`${SECTIONS.agent}?return=code`} className={buttonClass({ variant: "primary" })}>
          Подключить код агента
        </Link>
        {rulesButton("Выбрать набор правил")}
      </>
    );
  }
  return (
    <div className="max-w-[920px] px-4 pb-16 pt-8 lg:px-10">
      <p className="text-small font-medium text-fg-3">После кода агента</p>
      <h2 className="mt-1 text-page font-semibold text-fg">{title}</h2>
      <p className="mt-2 max-w-[62ch] text-read text-fg-3">{lead}</p>
      <div className="mt-6 flex flex-wrap items-center gap-2">{actions}</div>
      {criteria.length > 0 && (
        <ol className="mt-10 grid gap-3 sm:grid-cols-2">
          {criteria.map((c, i) => (
            <li key={c.id} className="rounded-[18px] bg-inset p-4">
              <p className="text-small tabular-nums text-fg-3">Критерий {i + 1}</p>
              <p className="mt-1 text-read font-semibold text-fg">{c.name}</p>
              <p className="mt-1 line-clamp-3 text-body text-fg-2">{c.text}</p>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
