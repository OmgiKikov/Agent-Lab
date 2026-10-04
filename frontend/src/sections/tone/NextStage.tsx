import { Link } from "react-router-dom";
import { ArrowRight, FlaskConical } from "lucide-react";
import { scenariosLink } from "../../app/links";
import { toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { Button } from "../../ui/Button";

/**
 * From a tone-of-voice result to the simulations: its errors become scenarios the synthetic customers play. Once this
 * check's scenarios are built, it says nothing: they wait in «Симуляции».
 */
export function NextStage({ state, onRecheck }: { state: LabState; onRecheck: () => void }) {
  if (state.cards?.check === "tone" && state.cards.cards.length) return null;
  const outdated = toneResult(state)?.criteriaRevision !== state.toneOfVoice?.revision;
  return (
    <section aria-labelledby="next-stage-title" className="mt-10 border-t border-line pt-6">
      <div className="flex items-center gap-3">
        <FlaskConical aria-hidden className="size-5 text-fg-3" strokeWidth={1.7} />
        <h3 id="next-stage-title" className="text-lead font-semibold text-fg">
          Дальше — сценарии и симуляции
        </h3>
      </div>
      <p className="mt-3 max-w-[65ch] text-read text-fg-2">
        {outdated
          ? "Чтобы собрать сценарии, сначала проверьте разговоры по уточнённым критериям."
          : "Из ошибок этой проверки соберите сценарии. Синтетические клиенты сыграют их с агентом, а модель проверит разговоры по тем же критериям."}
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
