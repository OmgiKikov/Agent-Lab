import type { Check } from "../../app/links";
import { useCriteria } from "../../lab/criteria";
import { useLabState } from "../../lab/LabProvider";
import { EmptyState, Skeleton } from "../../ui/EmptyState";
import { LoadFailed } from "../../ui/LoadFailed";
import { Sheet } from "../../ui/Sheet";
import { ReportSheet } from "../problems/ReportSheet";
import { BriefSheet, useToneBrief } from "../tone/BriefSheet";

type Props = { open: boolean; onClose: () => void };

function ToneReport({ open, onClose }: Props) {
  const { state } = useLabState();
  return <BriefSheet open={open} onClose={onClose} brief={useToneBrief(state)} />;
}

/**
 * The protocol of accuracy, once its record is here. Asked for before that, the sheet opens all the same: with the
 * shape of the report while the record loads, or saying it could not load it, with «Повторить».
 */
function AccuracyReport({ open, onClose }: Props) {
  const { data, list, loading, error, retry } = useCriteria("code");
  if (data && (data.log || data.sim)) return <ReportSheet open={open} onClose={onClose} data={data} list={list} />;
  return (
    <Sheet open={open} onClose={onClose} width="lg" title="Отчёт">
      <div className="px-5 py-6 sm:px-8">
        {error ? (
          <LoadFailed title="Не удалось загрузить отчёт" error={error} onRetry={retry} />
        ) : loading ? (
          <Skeleton className="mx-auto h-[480px] max-w-3xl" />
        ) : (
          <EmptyState drop title="Здесь будет отчёт для письма">
            Он появится после проверки точности.
          </EmptyState>
        )}
      </div>
    </Sheet>
  );
}

/**
 * «Отчёт для письма» of one check, the same from its section and from «Обзор»: tone of voice tells the team its brief
 * with the screen's number, accuracy its protocol of problems. Two checks are never in one report.
 */
export function CheckReport({ check, ...props }: Props & { check: Check }) {
  return check === "tone" ? <ToneReport {...props} /> : <AccuracyReport {...props} />;
}
