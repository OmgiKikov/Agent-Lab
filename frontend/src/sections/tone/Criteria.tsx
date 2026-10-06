import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Play, RotateCcw } from "lucide-react";
import { api } from "../../lab/api";
import { duty } from "../../lab/criteria";
import { count } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { toneResult } from "../../lab/tone";
import type { LabState, ToneDraft } from "../../lab/types";
import { Button } from "../../ui/Button";
import { Skeleton } from "../../ui/EmptyState";
import { Modal } from "../../ui/Modal";
import { useToast } from "../../ui/toast";
import { stopFailed } from "./Checking";

/** One check takes at most this many criteria (backend/lab/api/tone.py, ToneCheckCommand). */
const MAX_CRITERIA = 20;

/** The clarifications people confirmed on the criteria: the work that collecting criteria again can take away. */
export const clarificationsOf = (draft: ToneDraft | null | undefined) =>
  (draft?.criteria ?? []).reduce((n, c) => n + (c.clarifications?.length ?? 0), 0);

/** «У критериев 3 подтверждённых уточнения.» — how many there are, the first words of what happens to them. */
export const clarifiedText = (n: number, of = "У критериев") =>
  `${of} ${count(n, "подтверждённое уточнение", "подтверждённых уточнения", "подтверждённых уточнений")}.`;

/** The tone of voice scenarios of the agent: new criteria take them away (store.save_tone_draft). */
export const toneDeck = (state: LabState) => state.cards?.check === "tone" && !!state.cards.cards.length;

/**
 * A check of these criteria on this export that was stopped and can go on (the service keeps what it judged), also
 * when other tasks ran since: its criteria, how many conversations, and how many it judged, to offer the same start
 * again. A check stopped before exports were kept names none: it was of the export that is the newest now.
 */
function pausedCheck(state: LabState, exportId: string | null) {
  const job = state.paused?.["tone-check"];
  const input = job?.input;
  if (!job || !input?.ruleIds || !input.count || input.revision !== state.toneOfVoice?.revision) return null;
  if ((input.exportId ?? state.exports[0]?.id) !== exportId) return null;
  return { ruleIds: input.ruleIds, count: input.count, kept: job.kept ?? 0 };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((id) => b.includes(id));

export function Criteria({
  state,
  exportId,
  onBack,
  onStarted,
}: {
  state: LabState;
  exportId: string | null;
  onBack: () => void;
  onStarted: () => void;
}) {
  const { refresh } = useLabState();
  const toast = useToast();
  const draft = state.toneOfVoice;
  const result = toneResult(state);
  const paused = pausedCheck(state, exportId);
  // The conversations of the export chosen on the first step: what a check can take.
  const chosen = state.exports.find((e) => e.id === exportId) ?? null;
  const available = chosen?.total ?? 0;
  const [choice, setChoice] = useState<{ revision: string; ids: string[] } | null>(null);
  // While the first criteria are still being collected there is neither a draft nor a choice: nothing is chosen yet.
  // A stopped check that can go on is offered as it was: its criteria and its size.
  const ids =
    choice && choice.revision === draft?.revision
      ? choice.ids
      : (paused?.ruleIds ??
        (result?.criteriaRevision === draft?.revision
          ? result?.topics.flatMap((t) => t.rules.map((c) => c.id))
          : null) ??
        draft?.criteria.slice(0, MAX_CRITERIA).map((c) => c.id) ??
        []);
  const full = ids.length >= MAX_CRITERIA;
  const [chosenSize, setSize] = useState<number | null>(null);
  const size = chosenSize ?? paused?.count ?? 100;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Collecting the criteria anew from the same rules is asked first: it can take away what people made of them.
  const [asking, setAsking] = useState(false);
  const clarified = clarificationsOf(draft);
  const running = state.job.running;
  const generating = running && state.job.kind === "tone-criteria";
  const serviceError = state.job.kind === "tone-criteria" ? state.job.error : null;
  const total = Math.min(size, available);
  // The same start as the stopped check: it goes on from where it stopped, judging only the rest.
  const resumes = !!paused && total === paused.count && sameSet(ids, paused.ruleIds);
  const sizes = [...new Set([100, 200, 300].map((n) => Math.min(n, available)))];
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
      // After the check the automatic check proposes which errors are serious (lab/severity).
      await api("/api/tone-of-voice/check", {
        ruleIds: ids,
        count: total,
        revision: draft?.revision,
        propose: true,
        exportId,
      });
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
              api("/api/job/stop", {})
                .catch((e) => toast.error(stopFailed("сборку критериев", e)))
                .finally(() => void refresh())
            }
          >
            Остановить
          </Button>
        </div>
      ) : draft ? (
        <>
          {!available && (
            // Criteria taken from another agent can be here before this agent's conversations are.
            <div className="mt-6 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-sheet bg-inset p-5">
              <p className="min-w-0 flex-1 basis-64 text-read text-fg-2">
                Чтобы запустить проверку, выберите или загрузите выгрузку на первом шаге.
              </p>
              <Button onClick={onBack}>К выгрузке</Button>
            </div>
          )}
          <p className="mt-5 text-body text-fg-3">
            Выбрано {ids.length}
            {"\u00a0"}из{"\u00a0"}
            {draft.criteria.length}
            {draft.criteria.length > MAX_CRITERIA && ` · не больше ${MAX_CRITERIA} за одну проверку`}
          </p>
          <ul className="mt-2 divide-y divide-line border-y border-line">
            {draft.criteria.map((c, i) => (
              <li key={c.id} className="py-4">
                <label className="flex cursor-pointer items-start gap-3">
                  <input
                    type="checkbox"
                    checked={ids.includes(c.id)}
                    disabled={running || (full && !ids.includes(c.id))}
                    onChange={() => toggle(c.id)}
                    className="mt-1 size-4 accent-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-read font-semibold text-fg">
                      {i + 1}. {c.name}
                    </span>
                    {/* A ready rubric names its criteria by code; ids a model gave (t1r1…) mean nothing to a person. */}
                    {!draft.model && <span className="mt-0.5 block text-small text-fg-3">{c.id}</span>}
                  </span>
                </label>
                <details className="ml-7 mt-2 text-body">
                  <summary className="cursor-pointer text-fg-3 hover:text-fg">Формулировка и цитата</summary>
                  <p className="mt-2 whitespace-pre-wrap text-read text-fg-2">{duty(c.text)}</p>
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
          {available > 100 && (
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
                    {available === n ? `Все, ${n}` : n}
                  </option>
                ))}
              </select>
            </div>
          )}
          {!!available &&
            (resumes ? (
              <p className="mt-2 text-body text-fg-3">
                Проверка остановлена, проверенное сохранено: уже {paused?.kept ?? 0}
                {"\u00a0"}из{"\u00a0"}
                {total}. Продолжим с этого места, остальные разговоры проверим по тем же критериям.
              </p>
            ) : (
              <p className="mt-2 text-body text-fg-3">
                Проверим {total}
                {"\u00a0"}из{"\u00a0"}
                {count(available, "разговора", "разговоров", "разговоров")} выгрузки «{chosen?.name}» по{" "}
                {count(ids.length, "критерию", "критериям", "критериям")}. Подключать агента не нужно.
              </p>
            ))}
        </>
      ) : (
        !serviceError && <p className="mt-6 text-read text-fg-2">Критерии пока не собраны.</p>
      )}
      {(error || serviceError) && (
        <div role="alert" className="mt-5 text-read text-bad">
          <p>{error || serviceError}</p>
          <Link to="/settings" className="mt-2 inline-block text-body text-fg underline">
            Настройки моделей
          </Link>
        </div>
      )}
      <div className="sticky bottom-0 z-10 -mx-4 mt-7 flex flex-wrap items-center gap-3 border-t border-line bg-canvas/95 px-4 py-4 backdrop-blur">
        <Button icon={ArrowLeft} onClick={onBack} disabled={running}>
          К выгрузке и правилам
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
            {resumes ? "Продолжить проверку" : "Запустить проверку"}
          </Button>
        )}
        {!generating && (
          <Button
            variant="ghost"
            icon={RotateCcw}
            disabled={running || !available}
            title={available ? undefined : "Сначала выберите выгрузку"}
            onClick={draft ? () => setAsking(true) : regenerate}
          >
            {draft ? "Собрать заново" : "Собрать критерии"}
          </Button>
        )}
      </div>
      <Modal
        open={asking}
        onClose={() => setAsking(false)}
        title="Собрать критерии заново?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              Отмена
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setAsking(false);
                regenerate();
              }}
            >
              Собрать заново
            </Button>
          </>
        }
      >
        <p className="text-read text-fg-2">
          Критерии соберутся заново из тех же правил общения.
          {result ? " Итог tone of voice останется, но будет относиться к предыдущей версии критериев." : ""}
          {toneDeck(state) ? " Сценарии, собранные из tone of voice, сбросятся." : ""}
        </p>
        {clarified > 0 && (
          <p className="mt-3 text-read text-fg-2">
            {clarifiedText(clarified)} {clarified === 1 ? "Оно останется" : "Каждое останется"}, если цитата его
            критерия не изменится, иначе пропадёт.
          </p>
        )}
      </Modal>
    </section>
  );
}
