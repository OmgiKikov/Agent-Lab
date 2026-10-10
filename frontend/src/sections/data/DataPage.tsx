import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Archive, ArrowLeft, ArrowRight, Database, Info, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { SECTIONS, datasetLink, launchLink, stageRoot } from "../../app/links";
import { useWide } from "../../app/useWide";
import { CHECK_NAME, CHECKS, resultOf } from "../../lab/checks";
import { useDatasets, type Dataset } from "../../lab/datasets";
import { count, longDay, pct, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { useLaunches, type Launch } from "../../lab/launches";
import { inQuotes } from "../../lab/quote";
import type { LabState } from "../../lab/types";
import { ExportFormat } from "../../product/ExportFormat";
import { UploadButton } from "../../product/UploadLogs";
import { Button, buttonClass } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Tag } from "../../ui/Tag";
import { useToast } from "../../ui/toast";
import { ArchiveSheet, DatasetInfo, shownName } from "./DatasetInfo";
import { CheckCards, type Found } from "./CheckCards";
import { ExportConversations } from "./ExportConversations";

/** A number the line is about: dark and even, the rest of the line quiet. */
const Num = ({ n, bad }: { n: number; bad?: boolean }) => (
  <span className={cn("font-semibold tabular-nums", bad ? "text-bad" : "text-fg")}>{n}</span>
);

type Fact = { key: string; node: ReactNode };

/**
 * Facts in a row, a dot between them; a fact and its dot go to the next line together, and `end` (the button of the
 * details) with the last fact, never alone on a line of its own.
 */
function Facts({ facts, end }: { facts: Fact[]; end?: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
      {facts.map((fact, i) => (
        <span key={fact.key} className="whitespace-nowrap">
          {i > 0 && (
            <span aria-hidden className="mr-1.5">
              ·
            </span>
          )}
          {fact.node}
          {i === facts.length - 1 && end}
        </span>
      ))}
    </span>
  );
}

/**
 * What the checks found in a dataset: the agent's current results for the one the checks read now (the Обзор shows
 * them), the newest finished launch on it for another.
 */
function foundIn(d: Dataset, state: LabState, inWork: boolean, launches: Launch[] = []): Found[] {
  return CHECKS.flatMap((check) => {
    if (inWork) {
      const result = resultOf(state, check);
      if (!result) return [];
      const { failed, measured, unmeasured } = result.summary;
      return [{ check, line: { failed, measured, unmeasured, finishedAt: result.finishedAt }, to: stageRoot(check) }];
    }
    const launch = launches.find((l) => l.check === check && l.dataset?.datasetId === d.id && l.modes.dataset?.metric);
    const metric = launch?.modes.dataset?.metric;
    if (!launch || !metric) return [];
    const { failed, measured, unmeasured } = metric;
    return [
      { check, line: { failed, measured, unmeasured, finishedAt: launch.startedAt }, to: launchLink(check, launch.id) },
    ];
  });
}

/**
 * One dataset in the list: its name, how many conversations and when it came, and what each check found in it as
 * «Итог» says it — or that the one the checks read now is not checked yet. Among several, the one the checks go by is
 * marked «выбран для проверки» (`selected`) and any other has the button that chooses it (`action`). The row opens its
 * page; the button over it does only its own.
 */
function Row({
  d,
  found,
  unchecked,
  selected,
  action,
}: {
  d: Dataset;
  found: Found[];
  unchecked: boolean;
  selected: boolean;
  action?: ReactNode;
}) {
  // The button stands beside the arrow on a wide screen, under the facts on a phone, where the facts keep the width.
  return (
    <div
      className={cn(
        "group relative -mx-3 grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-3 rounded-block px-3 py-4 transition-colors focus-within:bg-hover hover:bg-hover",
        action && "sm:grid-cols-[minmax(0,1fr)_auto_auto]",
      )}
    >
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <Link
            to={datasetLink(d.id)}
            className="break-words text-read font-semibold text-fg after:absolute after:inset-0 after:rounded-block focus-visible:outline-none"
          >
            {shownName(d)}
          </Link>
          {selected && <Tag>выбран для проверки</Tag>}
        </span>
        <span className="mt-1 block text-body text-fg-3">
          {count(d.total, "разговор", "разговора", "разговоров")} · загружен {longDay(d.createdAt)}
          {d.skipped ? ` · пропущено ${d.skipped}` : ""}
        </span>
        {found.map(({ check, line }) => (
          <span key={check} className="mt-1 block text-body text-fg-3">
            {CHECK_NAME[check]}:{" "}
            {line.measured ? (
              <>
                <span className="font-semibold tabular-nums text-fg">
                  {pct(Math.max(0, line.measured - line.failed), line.measured)}%
                </span>{" "}
                без найденных ошибок · {longDay(line.finishedAt)}
              </>
            ) : (
              "ни один разговор не удалось проверить"
            )}
          </span>
        ))}
        {unchecked && !found.length && <span className="mt-1 block text-body text-fg-3">Ещё не проверен</span>}
      </span>
      <ArrowRight
        aria-hidden
        className={cn(
          "col-start-2 row-start-1 mt-1 size-4 text-fg-4 transition-transform group-hover:translate-x-0.5",
          action && "sm:col-start-3",
        )}
      />
      {action && <span className="relative z-10 col-start-1 row-start-2 sm:col-start-2 sm:row-start-1">{action}</span>}
    </div>
  );
}

/**
 * «Датасеты»: every dataset of the agent as a list, newest first, each with what the checks found in it, the one the
 * checks go by marked and any other chosen for them by its button; a dataset opens on its own page (`/data/:id`) with
 * its conversations as the file has them — looking at one changes nothing. «Добавить датасет» is the list's one black
 * button. The archive is under the list. Without a dataset, where to get one.
 */
export function DataPage() {
  const { datasetId } = useParams();
  const { state, offline } = useLabState();
  const library = useDatasets(true);
  const launches = useLaunches(undefined, `${state?.job.id}-${state?.job.running}`);
  const navigate = useNavigate();
  const toast = useToast();
  const [archive, setArchive] = useState(false);
  // The checks, «Итог» and «Обзор» go by the dataset chosen: its own results come back with it (flows/datasets).
  const choose = (d: Dataset) =>
    library
      .change("select", d.id)
      .then(() => toast.notify(`Для проверки выбран датасет ${inQuotes(shownName(d))}`))
      .catch(toast.error);

  const all = library.data?.datasets ?? [];
  const listed = all.filter((x) => !x.archivedAt);
  const archived = all.filter((x) => x.archivedAt);
  const activeId = library.data?.activeId ?? null;
  const header = (
    <Header
      title="Датасеты"
      actionsInline
      actions={
        !datasetId &&
        listed.length > 0 && (
          <UploadButton label="Добавить датасет" short="Добавить" onLoaded={() => void navigate(SECTIONS.data)} />
        )
      }
      below={<SectionJob kinds={["logs"]} />}
    />
  );
  if (!state || (!library.data && !library.isError))
    return (
      <div>
        {header}
        {offline ? <ServiceDown /> : <Skeleton className="m-8 h-80" />}
      </div>
    );
  if (library.isError)
    return (
      <div className="flex h-full flex-col">
        {header}
        <LoadFailed
          page
          title="Не удалось загрузить датасеты"
          error={library.error}
          onRetry={() => library.refetch()}
        />
      </div>
    );
  if (datasetId) {
    const d = all.find((x) => x.id === datasetId);
    if (!d)
      return (
        <div className="flex h-full flex-col">
          {header}
          <EmptyState
            drop
            title="Такого датасета нет"
            action={
              <Link to={SECTIONS.data} className={buttonClass()}>
                К датасетам
              </Link>
            }
          >
            У этого агента его нет: может быть, ссылка от другого агента.
          </EmptyState>
        </div>
      );
    return (
      <DatasetPage
        key={d.id}
        d={d}
        header={header}
        found={foundIn(d, state, d.id === activeId, launches.data?.launches)}
        inWork={d.id === activeId}
        next={listed.find((x) => x.id !== d.id) ?? null}
      />
    );
  }
  if (!listed.length)
    return (
      <div>
        {header}
        <div className="max-w-[1180px] px-4 pb-16 pt-8 lg:px-10">
          <h2 className="text-page font-semibold text-fg">
            {archived.length ? "Все датасеты в архиве" : "Начните с настоящих разговоров"}
          </h2>
          <p className="mt-3 max-w-[65ch] text-read text-fg-3">
            {archived.length
              ? "Верните нужный из архива или загрузите новый датасет."
              : "Датасет — файл с настоящими разговорами клиентов из чата: по нему проверяется агент."}
          </p>
          {archived.length > 0 && (
            <Button className="mt-5" icon={Archive} onClick={() => setArchive(true)}>
              Архив · {archived.length}
            </Button>
          )}
          <div className="mt-7 grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(260px,2fr)]">
            <div className="flex flex-col items-center rounded-block border border-dashed border-line-strong bg-inset/40 px-6 py-12 text-center">
              <span className="mb-5 flex size-12 items-center justify-center rounded-block bg-hover text-fg-3">
                <Database aria-hidden className="size-6" />
              </span>
              <h3 className="text-read font-semibold text-fg">Добавьте датасет</h3>
              <p className="mb-6 mt-2 text-body text-fg-3">XLSX, JSONL, JSON или CSV · до 50 МБ</p>
              <UploadButton />
              <p className="mt-4 text-small text-fg-3">Подключение к агенту не требуется.</p>
            </div>
            <ExportFormat />
          </div>
          {!archived.length && (
            <Link to={SECTIONS.overview} className={`mt-7 ${buttonClass({ variant: "ghost" })}`}>
              К обзору
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </div>
        <ArchiveSheet open={archive} onClose={() => setArchive(false)} archived={archived} />
      </div>
    );
  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="max-w-[880px] px-4 pb-16 pt-4 lg:px-10 lg:pt-6">
          <ul aria-label="Датасеты" className="divide-y divide-line">
            {listed.map((d) => {
              const inWork = d.id === activeId;
              const several = listed.length > 1;
              return (
                <li key={d.id}>
                  <Row
                    d={d}
                    found={foundIn(d, state, inWork, launches.data?.launches)}
                    unchecked={inWork}
                    selected={several && inWork}
                    action={
                      several &&
                      !inWork && (
                        <Button
                          size="sm"
                          disabled={library.changing || !!state.job.running}
                          title={state.job.running ? "Дождитесь завершения текущей задачи" : undefined}
                          onClick={() => void choose(d)}
                        >
                          Выбрать для проверки
                        </Button>
                      )
                    }
                  />
                </li>
              );
            })}
          </ul>
          {archived.length > 0 && (
            <button
              type="button"
              onClick={() => setArchive(true)}
              className="mt-6 inline-flex items-center gap-1.5 rounded-control text-body text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
            >
              <Archive aria-hidden className="size-4" />
              Архив · {archived.length}
            </button>
          )}
        </div>
      </div>
      <ArchiveSheet open={archive} onClose={() => setArchive(false)} archived={archived} />
    </div>
  );
}

/**
 * One dataset on its own page: «← Датасеты», its name with what the file holds and whose answers in one line (details,
 * the name, the agent's version and the archive behind ⓘ), what each check found in it with the way into a check of
 * it, then its conversations as the file has them. Looking at one changes nothing: a check of it is started from its
 * card.
 */
function DatasetPage({
  d,
  header,
  found,
  inWork,
  next,
}: {
  d: Dataset;
  header: ReactNode;
  found: Found[];
  inWork: boolean;
  /** The newest dataset left, which goes into work when this one in work goes to the archive (flows/datasets). */
  next: Dataset | null;
}) {
  const { state } = useLabState();
  const library = useDatasets(true);
  const [params] = useSearchParams();
  const wide = useWide();
  const navigate = useNavigate();
  const toast = useToast();
  const [info, setInfo] = useState(false);
  // What the file holds, then what the checks found: two groups, each whole on a line of its own when they wrap.
  const held: Fact[] = [
    {
      key: "total",
      node: (
        <>
          <Num n={d.total} /> {plural(d.total, "разговор", "разговора", "разговоров")}
        </>
      ),
    },
    { key: "at", node: `загружен ${longDay(d.createdAt)}` },
    ...(d.skipped
      ? [
          {
            key: "skipped",
            node: (
              <button
                type="button"
                onClick={() => setInfo(true)}
                title="В них первым пишет агент или он не отвечает"
                className="rounded-sm text-warn underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
              >
                пропущено <span className="font-semibold tabular-nums">{d.skipped}</span>
              </button>
            ),
          },
        ]
      : []),
    ...(d.archivedAt ? [{ key: "archived", node: `в архиве с ${longDay(d.archivedAt)}` }] : []),
    // Whose answers the dataset holds: shown, and set or changed in «Подробности».
    {
      key: "version",
      node: (
        <button
          type="button"
          onClick={() => setInfo(true)}
          className={cn(
            "rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60",
            !d.agentVersion && "text-run",
          )}
        >
          {d.agentVersion ? `версия агента ${d.agentVersion}` : "указать версию агента"}
        </button>
      ),
    },
  ];
  // On a phone an open conversation takes the whole page.
  const reading = !!params.get("d") && !wide;
  const archivedNow = (gone: Dataset, wasInWork: boolean) => {
    setInfo(false);
    void navigate(SECTIONS.data);
    toast.notify(`Датасет ${inQuotes(shownName(gone))} в архиве`, {
      label: "Вернуть",
      run: () =>
        void (async () => {
          try {
            await library.change("archive", gone.id, { undo: true });
            // In work before the archive: in work again, as it was.
            if (wasInWork) await library.change("select", gone.id);
          } catch (cause) {
            toast.error(cause);
          }
        })(),
    });
  };
  return (
    // A wide screen keeps the list and the conversation in view under the cards; a phone scrolls the whole page.
    <div className="flex flex-col lg:h-full">
      {header}
      {!reading && (
        <section aria-label="Датасет" className="flex-shrink-0 border-b border-line px-4 py-5 lg:px-10">
          <Link
            to={SECTIONS.data}
            className="inline-flex items-center gap-1.5 rounded-sm text-body text-fg-3 transition-colors hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
          >
            <ArrowLeft aria-hidden className="size-4" />
            Датасеты
          </Link>
          <div className="mt-3 flex flex-wrap items-start gap-x-10 gap-y-4">
            <div className="min-w-[min(100%,22rem)] flex-1">
              <h2 className="break-words text-title font-semibold text-fg">{shownName(d)}</h2>
              <p className="mt-1 text-read text-fg-3">
                <Facts
                  facts={held}
                  end={
                    <button
                      type="button"
                      aria-label="Подробности"
                      title="Подробности"
                      onClick={() => setInfo(true)}
                      className="ml-1 inline-grid size-7 place-items-center rounded-full align-middle text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
                    >
                      <Info aria-hidden className="size-4" />
                    </button>
                  }
                />
              </p>
            </div>
            {d.archivedAt && (
              <Button
                icon={RotateCcw}
                disabled={library.changing || !!state?.job.running}
                onClick={() =>
                  void library.change("archive", d.id, { undo: true }).catch((cause) => toast.error(cause))
                }
              >
                Вернуть из архива
              </Button>
            )}
          </div>
          <div className="mt-5">
            <CheckCards found={found} datasetId={d.id} archived={!!d.archivedAt} />
          </div>
        </section>
      )}
      <ExportConversations datasetId={d.id} />
      <DatasetInfo
        open={info}
        onClose={() => setInfo(false)}
        dataset={d}
        inWork={inWork}
        next={next}
        onArchived={archivedNow}
      />
    </div>
  );
}
