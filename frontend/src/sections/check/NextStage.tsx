import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { scenariosLink } from "../../app/links";
import { toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { Step } from "../../product/Step";
import { Button } from "../../ui/Button";

/** The recorded-conversation result is the starting point for the same product's synthetic scenarios. */
export function NextStage({ state, onRecheck }: { state: LabState; onRecheck: () => void }) {
  const outdated = toneResult(state)?.criteriaRevision !== state.toneOfVoice?.revision;
  return (
    <section aria-labelledby="next-stage-title" className="mt-10 border-t border-line pt-6">
      <div className="flex items-center gap-3">
        <Step n={2} />
        <h3 id="next-stage-title" className="text-lead font-semibold text-fg">
          Дальше — сценарии и симуляции
        </h3>
      </div>
      <p className="mt-3 max-w-[65ch] text-read text-fg-2">
        {outdated
          ? "Сначала повторите оценку по уточнённым критериям. Из нового результата можно собрать сценарии для проверки агента."
          : "Из проверенных разговоров и найденных ошибок соберите карточки сценариев. Затем синтетические клиенты разыграют эти ситуации с агентом, а ответы будут проверены по тем же критериям."}
      </p>
      {outdated ? (
        <Button className="mt-4" size="lg" disabled={state.job.running} onClick={onRecheck}>
          Проверить по новым критериям
        </Button>
      ) : (
        <Link
          to={scenariosLink()}
          className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-full bg-hover px-5 text-read font-medium text-fg hover:bg-selected focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
        >
          Перейти к сценариям
          <ArrowRight aria-hidden className="size-4" />
        </Link>
      )}
    </section>
  );
}
