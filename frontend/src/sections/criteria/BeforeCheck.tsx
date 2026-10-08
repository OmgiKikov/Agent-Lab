import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { BookOpen, Play } from "lucide-react";
import { launchLink, SECTIONS, type Check } from "../../app/links";
import { count } from "../../lab/format";
import type { JudgeVersion } from "../../lab/judges";
import { useLabState } from "../../lab/LabProvider";
import { codeSources, TONE_ID } from "../../lab/tone";
import { Button, buttonClass } from "../../ui/Button";
import { AddRules } from "./AddRules";

/**
 * «Критерии» before the first check: the step after the rules. The criteria the model collected from the rules — what
 * the check will go by — to read before anything is spent, with «Новая проверка» as the next step. Tone of voice without
 * its rules gives them right here (AddRules: a document, a text, another agent's), and while the model collects the
 * criteria their places wait. Точность without the agent's code says where its criteria come from and the way to it.
 */
export function BeforeCheck({
  check,
  rules,
  onRules,
}: {
  check: Check;
  rules: JudgeVersion | null;
  /** Opens the rule sets: to change the criteria or take another set. */
  onRules: () => void;
}) {
  const { state } = useLabState();
  const tone = check === "tone";
  const collecting = !!state?.job.running && state.job.kind === "tone-criteria";
  const policy = state?.sources.find((s) => s.id === TONE_ID);
  const code = codeSources(state).length > 0;
  const criteria = rules?.criteria ?? [];
  const launch = (
    <Link to={launchLink(check)} className={buttonClass({ variant: "primary" })}>
      <Play aria-hidden className="size-3.5" />
      Новая проверка
    </Link>
  );
  const rulesButton = (label: string, primary = false) => (
    <Button variant={primary ? "primary" : "outline"} icon={BookOpen} onClick={onRules}>
      {label}
    </Button>
  );
  let title: string;
  let lead: string;
  let actions: ReactNode;
  if (criteria.length) {
    title = `${count(criteria.length, "критерий", "критерия", "критериев")} из «${rules!.name}»`;
    lead = tone
      ? "Так мы поняли ваши правила общения. Проверьте, всё ли верно: по этим критериям пойдёт проверка."
      : "Так мы поняли ваш набор правил. По этим критериям пойдёт проверка.";
    actions = (
      <>
        {launch}
        {rulesButton("Правила")}
      </>
    );
  } else if (tone) {
    title = collecting
      ? `Собираем критерии из «${policy?.origin || "правил общения"}»`
      : "Сначала нужны правила общения";
    lead = collecting
      ? "Модель читает правила и собирает из них критерии. Это займёт пару минут: они появятся здесь."
      : "Дайте Lab правила общения банка: документ, текст или правила другого агента. Модель соберёт из них критерии, и они появятся здесь.";
    actions = null;
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
      <p className="text-small font-medium text-fg-3">
        {tone ? (criteria.length || collecting ? "После правил общения" : "Правила общения") : "После кода агента"}
      </p>
      <h2 className="mt-1 text-page font-semibold text-fg">{title}</h2>
      <p className="mt-2 max-w-[62ch] text-read text-fg-3">{lead}</p>
      {actions && <div className="mt-6 flex flex-wrap items-center gap-2">{actions}</div>}
      {tone && !criteria.length && !collecting && state && <AddRules />}
      {tone && !criteria.length && collecting && (
        <ol aria-hidden className="mt-10 grid gap-3 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="h-[104px] animate-pulse rounded-[18px] bg-inset" />
          ))}
        </ol>
      )}
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
