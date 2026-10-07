import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Archive, ArrowRight, ChevronDown, ChevronRight, Database, Info, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { SECTIONS, datasetLink, launchLink, stageRoot, type Check } from "../../app/links";
import { useWide } from "../../app/useWide";
import { CHECK_NAME, CHECKS, resultOf } from "../../lab/checks";
import { useDatasets, type Dataset } from "../../lab/datasets";
import { count, longDay, plural } from "../../lab/format";
import { useLabState } from "../../lab/LabProvider";
import { useLaunches } from "../../lab/launches";
import { ExportFormat } from "../../product/ExportFormat";
import { UploadButton } from "../../product/UploadLogs";
import { Button, buttonClass } from "../../ui/Button";
import { EmptyState, ServiceDown, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Menu, type MenuItem } from "../../ui/Menu";
import { useToast } from "../../ui/toast";
import { ArchiveSheet, DatasetInfo, shownName } from "./DatasetInfo";
import { ExportConversations } from "./ExportConversations";

const conversations = (n: number) => count(n, "разговор", "разговора", "разговоров");

/** A number the line is about: dark and even, the rest of the line quiet. */
const Num = ({ n, bad }: { n: number; bad?: boolean }) => (
  <span className={cn("font-semibold tabular-nums", bad ? "text-bad" : "text-fg")}>{n}</span>
);

/** The way to a check not done yet, in the prototype's words. */
const CHECK_LAUNCH: Record<Check, string> = { tone: "Проверить Tone of voice", code: "Проверить точность" };

type Fact = { key: string; node: ReactNode };

/** Facts in a row, a dot between them; a fact and its dot go to the next line together. */
function Facts({ facts }: { facts: Fact[] }) {
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
        </span>
      ))}
    </span>
  );
}

/** What a check found, in the words of every result: errors of what it could check, the errors red as there. */
const foundText = (check: Check, failed: number, measured: number) =>
  measured ? (
    <>
      {CHECK_NAME[check]}: <Num n={failed} bad={failed > 0} /> из <Num n={measured} /> с ошибкой
    </>
  ) : (
    `${CHECK_NAME[check]}: не удалось проверить`
  );

/**
 * «Датасеты»: one export at a time, the newest by default — what it holds and what the checks found in it, in one line,
 * then its conversations as the file has them. The others open from its name; looking at one changes nothing. Its
 * details and the archive are behind ⓘ. Without one, where to get it.
 */
export function DataPage() {
  const { datasetId } = useParams();
  const { state, offline } = useLabState();
  const library = useDatasets(true);
  const launches = useLaunches(undefined, `${state?.job.id}-${state?.job.running}`);
  const [params] = useSearchParams();
  const wide = useWide();
  const navigate = useNavigate();
  const toast = useToast();
  const [info, setInfo] = useState(false);
  const [archive, setArchive] = useState(false);

  const all = library.data?.datasets ?? [];
  const listed = all.filter((x) => !x.archivedAt);
  const archived = all.filter((x) => x.archivedAt);
  const activeId = library.data?.activeId ?? null;
  const d = datasetId ? all.find((x) => x.id === datasetId) : (listed.find((x) => x.id === activeId) ?? listed[0]);
  const header = (
    <Header
      title="Датасеты"
      actionsInline
      actions={
        listed.length > 0 && (
          <UploadButton
            variant="outline"
            label="Добавить датасет"
            compact
            onLoaded={() => void navigate(SECTIONS.data)}
          />
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
  if (datasetId && !d)
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
  if (!d)
    return (
      <div>
        {header}
        <div className="max-w-[1180px] px-4 pb-16 pt-8 lg:px-10">
          <h2 className="text-page font-semibold text-fg">
            {archived.length ? "Все датасеты в архиве" : "Начните с настоящих разговоров"}
          </h2>
          <p className="mt-3 max-w-[65ch] text-read text-fg-3">
            {archived.length
              ? "Верните нужный из архива или загрузите новую выгрузку."
              : "Выгрузка чата с настоящими разговорами клиентов: по ней проверяется агент."}
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
              <h3 className="text-read font-semibold text-fg">Добавьте выгрузку чата</h3>
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

  const inWork = d.id === activeId;
  // What the checks found in it: the agent's current results for the one in work (the Обзор shows them), the newest
  // finished launch on it for another.
  const found = CHECKS.flatMap((check) => {
    if (inWork) {
      const result = resultOf(state, check);
      return result
        ? [{ check, text: foundText(check, result.summary.failed, result.summary.measured), to: stageRoot(check) }]
        : [];
    }
    const launch = launches.data?.launches.find(
      (l) => l.check === check && l.dataset?.datasetId === d.id && l.modes.dataset?.metric,
    );
    const metric = launch?.modes.dataset?.metric;
    return launch && metric
      ? [{ check, text: foundText(check, metric.failed, metric.measured), to: launchLink(check, launch.id) }]
      : [];
  });
  // The newest dataset left goes into work when the one in work goes to the archive (backend: flows/datasets.archive).
  const next = listed.find((x) => x.id !== d.id) ?? null;
  const choices: MenuItem[] = [
    ...(listed.length > 1 || (d.archivedAt && listed.length)
      ? listed.map((x) => ({
          key: x.id,
          label: shownName(x),
          sub: `${conversations(x.total)} · загружен ${longDay(x.createdAt)}`,
          on: x.id === d.id,
          run: () => void navigate(x.id === activeId ? SECTIONS.data : datasetLink(x.id)),
        }))
      : []),
    ...(archived.length
      ? [
          {
            key: "archive",
            label: "Архив",
            sub: count(archived.length, "датасет", "датасета", "датасетов"),
            run: () => setArchive(true),
          },
        ]
      : []),
  ];
  const title = shownName(d);
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
  ];
  // The checks of this dataset, each its own pill: what it found, leading to it; or, not done, the way to do it. The
  // first not done is the next step and the one black pill; with both done, no pill calls.
  const nextCheck = d.archivedAt ? undefined : CHECKS.find((check) => !found.some((f) => f.check === check));
  const pills = CHECKS.flatMap((check) => {
    const f = found.find((x) => x.check === check);
    if (f)
      return [
        <Link key={check} to={f.to} className={cn(buttonClass({ variant: "outline" }), "font-normal")}>
          {/* One piece of text: the pill spaces its icon apart, not the words. */}
          <span>{f.text}</span>
          <ChevronRight aria-hidden className="size-3.5 text-fg-3" />
        </Link>,
      ];
    if (d.archivedAt) return [];
    return [
      <Link
        key={check}
        to={`${launchLink(check)}?dataset=${encodeURIComponent(d.id)}`}
        className={buttonClass({ variant: check === nextCheck ? "primary" : "outline" })}
      >
        {CHECK_LAUNCH[check]}
      </Link>,
    ];
  });
  // On a phone an open conversation takes the whole page.
  const reading = !!params.get("d") && !wide;
  const archivedNow = (gone: Dataset, wasInWork: boolean) => {
    setInfo(false);
    void navigate(SECTIONS.data);
    toast.notify(`«${shownName(gone)}» в архиве`, {
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
    <div className="flex h-full flex-col">
      {header}
      {!reading && (
        <section aria-label="Датасет" className="flex-shrink-0 border-b border-line px-4 py-5 lg:px-10">
          <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
            {/* On a phone «Проверить» goes under the line, which keeps its facts whole. */}
            <div className="min-w-[min(100%,22rem)] flex-1">
              <h2 className={choices.length ? "sr-only" : "break-words text-title font-semibold text-fg"}>{title}</h2>
              {choices.length > 0 && (
                <Menu
                  items={choices}
                  className="max-w-full"
                  trigger={
                    <span className="flex min-w-0 items-center gap-1.5 text-left">
                      <span className="min-w-0 break-words text-title font-semibold text-fg">{title}</span>
                      <ChevronDown aria-hidden className="size-4 flex-shrink-0 text-fg-3" />
                    </span>
                  }
                />
              )}
              <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-read text-fg-3">
                <Facts facts={held} />
                <button
                  type="button"
                  aria-label="Подробности"
                  title="Подробности"
                  onClick={() => setInfo(true)}
                  className="-ml-2.5 grid size-7 place-items-center rounded-full text-fg-3 transition-colors hover:bg-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-run/60"
                >
                  <Info aria-hidden className="size-4" />
                </button>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {pills}
              {d.archivedAt && (
                <Button
                  icon={RotateCcw}
                  disabled={library.changing || !!state.job.running}
                  onClick={() =>
                    void library.change("archive", d.id, { undo: true }).catch((cause) => toast.error(cause))
                  }
                >
                  Вернуть из архива
                </Button>
              )}
            </div>
          </div>
        </section>
      )}
      <ExportConversations key={d.id} datasetId={d.id} />
      <DatasetInfo
        open={info}
        onClose={() => setInfo(false)}
        dataset={d}
        inWork={inWork}
        next={next}
        onArchived={archivedNow}
      />
      <ArchiveSheet open={archive} onClose={() => setArchive(false)} archived={archived} />
    </div>
  );
}
