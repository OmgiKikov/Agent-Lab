import { Link } from "react-router-dom";
import { ArrowRight, FileText, MessagesSquare } from "lucide-react";
import { Header } from "../../app/Header";
import { SECTIONS } from "../../app/links";
import { useLabState } from "../../lab/LabProvider";
import { nextStep } from "../../lab/tone";
import { Button } from "../../ui/Button";

export function StartPage() {
  const { state } = useLabState();
  const resume =
    !!state?.toneOfVoice || (!!state?.job.running && ["tone-criteria", "tone-check"].includes(state.job.kind ?? ""));
  return (
    <div className="flex h-full flex-col">
      <Header title="Начать проверку" />
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[920px] px-4 pb-24 pt-10 lg:px-10 lg:pt-14">
          <p className="text-read font-medium text-fg-3">Tone of voice</p>
          <h2 className="mt-2 max-w-[22ch] text-page font-semibold text-fg">Как агент общается с клиентами</h2>
          <p className="mt-4 max-w-[58ch] text-lead text-fg-2">
            Загрузите разговоры и правила общения. Проверьте критерии, запустите оценку и получите метрику с примерами
            ошибок.
          </p>
          <div className="mt-10 grid gap-7 border-y border-line py-7 sm:grid-cols-2">
            <div className="flex items-start gap-3">
              <MessagesSquare aria-hidden className="mt-0.5 size-5 text-fg-3" />
              <div>
                <h3 className="text-read font-semibold text-fg">Разговоры</h3>
                <p className="mt-1 text-body text-fg-3">Выгрузка чата в Excel или JSONL.</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <FileText aria-hidden className="mt-0.5 size-5 text-fg-3" />
              <div>
                <h3 className="text-read font-semibold text-fg">Правила tone of voice</h3>
                <p className="mt-1 text-body text-fg-3">Текст или файл с требованиями к общению.</p>
              </div>
            </div>
          </div>
          <div className="mt-8 flex flex-wrap items-center gap-4">
            <Link to={`/check?step=${resume ? nextStep(state) : "materials"}`}>
              <Button variant="primary" size="lg">
                {resume ? "Продолжить проверку" : "Начать проверку"}
                <ArrowRight aria-hidden className="size-4" />
              </Button>
            </Link>
            <Link
              to={SECTIONS.overview}
              className="text-read text-fg-3 underline decoration-line-strong underline-offset-4 hover:text-fg"
            >
              Открыть рабочую область
            </Link>
          </div>
          <p className="mt-4 text-body text-fg-3">Для оценки готовых разговоров подключение к агенту не требуется.</p>
        </div>
      </div>
    </div>
  );
}
