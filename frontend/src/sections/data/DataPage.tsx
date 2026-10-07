import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, Database } from "lucide-react";
import { Header } from "../../app/Header";
import { SectionJob } from "../../app/SectionJob";
import { SECTIONS } from "../../app/links";
import { useWide } from "../../app/useWide";
import { useLabState } from "../../lab/LabProvider";
import { ExportFormat } from "../../product/ExportFormat";
import { UploadButton } from "../../product/UploadLogs";
import { buttonClass } from "../../ui/Button";
import { ServiceDown, Skeleton } from "../../ui/EmptyState";
import { ArchivedOnly, DatasetHead } from "./DatasetHead";
import { ExportConversations } from "./ExportConversations";

/**
 * The dataset the checks go by and its conversations as the file has them: the name and what was checked on top, the
 * conversations with a search on the left, one of them in full on the right. Without a dataset, where to get one.
 */
export function DataPage() {
  const { state, offline } = useLabState();
  const [params] = useSearchParams();
  const wide = useWide();
  const loaded = !!state?.logs.total;
  const header = (
    <Header
      title="Датасеты"
      actions={loaded && <UploadButton variant="outline" label="Добавить датасет" compact />}
      below={<SectionJob kinds={["logs"]} />}
    />
  );
  if (!state)
    return (
      <div>
        {header}
        {offline ? <ServiceDown /> : <Skeleton className="m-8 h-80" />}
      </div>
    );
  if (!loaded)
    return (
      <div>
        {header}
        <div className="max-w-[1180px] px-4 pb-16 pt-8 lg:px-10">
          <h2 className="text-page font-semibold text-fg">Начните с настоящих разговоров</h2>
          <p className="mt-3 max-w-[65ch] text-read text-fg-3">
            Выгрузка чата с настоящими разговорами клиентов: по ней проверяется агент.
          </p>
          <ArchivedOnly />
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
          <Link to={SECTIONS.overview} className={`mt-7 ${buttonClass({ variant: "ghost" })}`}>
            К обзору
            <ArrowRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      </div>
    );
  // On a phone an open conversation takes the whole page, as in «Разговоры».
  const reading = !!params.get("d") && !wide;
  return (
    <div className="flex h-full flex-col">
      {header}
      {!reading && <DatasetHead state={state} />}
      <ExportConversations key={state.logs.updatedAt ?? state.logs.total} stamp={state.logs.updatedAt} />
    </div>
  );
}
