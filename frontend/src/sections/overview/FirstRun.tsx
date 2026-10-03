import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Mark } from "../../app/Mark";
import { SECTIONS } from "../../app/links";
import { buttonClass } from "../../ui/Button";
import { TONE_ONLY } from "../../app/product";
import { useLabState } from "../../lab/LabProvider";

/** Before the first assessment: what will appear here, and the one way in — the start, where the metric is chosen. */
export function FirstRun() {
  const { state } = useLabState();
  // The first check is already running: the way in is its progress, not another start.
  if (state?.job.running && state.job.kind === "tone-check")
    return (
      <div className="mx-auto w-full max-w-2xl px-5 py-14">
        <Mark quiet className="size-12 rounded-2xl" />
        <h2 className="mt-6 text-balance text-title font-semibold text-fg">Идёт проверка tone of voice</h2>
        <p className="mt-2 max-w-[60ch] text-read text-fg-2">
          Итог появится здесь, когда модель проверит разговоры. Страницу можно закрыть: результат сохранится.
        </p>
        <Link to="/check?step=checking" className={`mt-8 ${buttonClass({ variant: "primary", size: "lg" })}`}>
          Ход проверки
          <ArrowRight aria-hidden className="size-4" />
        </Link>
      </div>
    );
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-14">
      <Mark quiet className="size-12 rounded-2xl" />
      <h2 className="mt-6 text-balance text-title font-semibold text-fg">
        {TONE_ONLY ? "Здесь появится оценка tone of voice" : "Здесь появится оценка диалогов"}
      </h2>
      <p className="mt-2 max-w-[60ch] text-read text-fg-2">
        {TONE_ONLY
          ? "Загрузите выгрузку чата и правила общения: проверим по ним настоящие диалоги и покажем, где агент говорит не так, как договорились."
          : "Выберите, что проверяем: tone of voice по вашим правилам общения или точность по коду агента. Найденные ошибки станут сценариями, и по тем же критериям агента проверят синтетические клиенты."}
      </p>
      <Link to={SECTIONS.start} className={`mt-8 ${buttonClass({ variant: "primary", size: "lg" })}`}>
        Начать проверку
        <ArrowRight aria-hidden className="size-4" />
      </Link>
    </div>
  );
}
