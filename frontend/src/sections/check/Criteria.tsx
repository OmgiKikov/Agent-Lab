import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Play, RotateCcw } from "lucide-react";
import { api } from "../../lab/api";
import { count } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { toneResult } from "../../lab/tone";
import type { LabState } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";

export function Criteria({ state, onBack, onStarted }: { state: LabState; onBack: () => void; onStarted: () => void }) {
  const { refresh } = useLabState();
  const draft = state.toneOfVoice;
  const result = toneResult(state);
  const [choice, setChoice] = useState<{ revision: string; ids: string[] } | null>(null);
  const ids =
    choice?.revision === draft?.revision
      ? choice!.ids
      : ((result?.criteriaRevision === draft?.revision
          ? result?.topics.flatMap((t) => t.rules.map((c) => c.id))
          : null) ??
        draft?.criteria.map((c) => c.id) ??
        []);
  const [size, setSize] = useState(100);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = state.job.running;
  const generating = running && state.job.kind === "tone-criteria";
  const serviceError = state.job.kind === "tone-criteria" ? state.job.error : null;
  const total = Math.min(size, state.logs.total);
  const sizes = [...new Set([100, 200, 300].map((n) => Math.min(n, state.logs.total)))];
  const toggle = (id: string) =>
    draft &&
    setChoice({ revision: draft.revision, ids: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id] });
  const regenerate = () => {
    api("/api/tone-of-voice/criteria", {})
      .then(() => refresh())
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      await api("/api/tone-of-voice/check", { ruleIds: ids, count: total, revision: draft?.revision });
      await refresh();
      onStarted();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };
  return (
    <section aria-labelledby="criteria-title">
      <h2 id="criteria-title" className="text-title font-semibold text-fg">
        Что проверим в ответах агента
      </h2>
      <p className="mt-2 text-read text-fg-3">
        Критерии собраны из ваших правил. Проверьте формулировки и выберите нужные.
      </p>
      {generating ? (
        <div role="status" className="mt-6">
          <p className="mb-3 text-read text-fg-2">Собираем критерии…</p>
          <Skeleton className="h-64" />
          <Button
            className="mt-3"
            onClick={() =>
              api("/api/job/stop", {}).then(
                () => refresh(),
                () => refresh(),
              )
            }
          >
            Остановить
          </Button>
        </div>
      ) : draft ? (
        <>
          <p className="mt-5 text-body text-fg-3">
            Выбрано {ids.length} из {draft.criteria.length}
          </p>
          <ul className="mt-2 divide-y divide-line border-y border-line">
            {draft.criteria.map((c, i) => (
              <li key={c.id} className="py-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={ids.includes(c.id)}
                    disabled={running}
                    onChange={() => toggle(c.id)}
                    className="mt-1 size-4 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-read font-semibold text-fg">
                      {i + 1}. {c.name}
                    </span>
                    <span className="mt-0.5 block text-small text-fg-3">{c.id}</span>
                  </span>
                </label>
                <details className="ml-7 mt-2 text-body">
                  <summary className="cursor-pointer text-fg-3 hover:text-fg">Требование и источник</summary>
                  <p className="mt-2 whitespace-pre-wrap text-read text-fg-2">{c.text}</p>
                  <blockquote className="mt-3 whitespace-pre-wrap border-l-2 border-mark pl-3 text-body text-fg-3">
                    {c.quote}
                  </blockquote>
                  {c.acceptable && <p className="mt-2 whitespace-pre-wrap text-body text-fg-3">{c.acceptable}</p>}
                  {!!c.clarifications?.length && (
                    <div className="mt-3 border-l-2 border-run pl-3">
                      <p className="font-medium text-fg">Ваши уточнения</p>
                      {c.clarifications.map((text, index) => (
                        <p key={index} className="mt-2 whitespace-pre-wrap text-read text-fg-2">
                          {text}
                        </p>
                      ))}
                    </div>
                  )}
                </details>
              </li>
            ))}
          </ul>
          {state.logs.total > 100 && (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <label htmlFor="tone-count" className="text-read font-medium text-fg">
                Сколько разговоров проверить
              </label>
              <select
                id="tone-count"
                value={size}
                onChange={(e) => setSize(Number(e.target.value))}
                disabled={running}
                className="rounded-control border border-line-strong bg-canvas px-3 py-2 text-body text-fg"
              >
                {sizes.map((n) => (
                  <option key={n} value={n}>
                    {state.logs.total === n ? `Все, ${n}` : n}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="mt-2 text-body text-fg-3">
            Проверим {total} из {state.logs.total} разговоров по{" "}
            {count(ids.length, "критерию", "критериям", "критериям")}. Подключение к агенту не требуется.
          </p>
        </>
      ) : (
        !serviceError && <p className="mt-6 text-read text-fg-2">Критерии пока не собраны.</p>
      )}
      {(error || serviceError) && (
        <div role="alert" className="mt-5 text-read text-bad">
          <p>{error || serviceError}</p>
          <Link to="/settings" className="mt-2 inline-block text-body text-fg underline">
            Проверить настройки моделей
          </Link>
        </div>
      )}
      <div className="sticky bottom-0 z-10 -mx-4 mt-7 flex flex-wrap items-center gap-3 border-t border-line bg-canvas/95 px-4 py-4 backdrop-blur">
        <Button icon={ArrowLeft} onClick={onBack} disabled={running}>
          К материалам
        </Button>
        {draft && !generating && (
          <Button
            variant="primary"
            className="order-first w-full sm:order-none sm:w-auto"
            size="lg"
            icon={Play}
            loading={starting}
            disabled={running || !ids.length || !total}
            onClick={start}
          >
            Запустить проверку
          </Button>
        )}
        {!generating && (
          <Button variant="ghost" icon={RotateCcw} disabled={running} onClick={regenerate}>
            {draft ? "Собрать заново" : "Повторить сборку"}
          </Button>
        )}
      </div>
    </section>
  );
}
