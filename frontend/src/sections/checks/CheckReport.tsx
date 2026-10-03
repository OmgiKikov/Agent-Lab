import type { Check } from "../../app/links";
import { useCriteria } from "../../lab/criteria";
import { useLabState } from "../../lab/LabProvider";
import { ReportSheet } from "../problems/ReportSheet";
import { BriefSheet, useToneBrief } from "../tone/BriefSheet";

type Props = { open: boolean; onClose: () => void };

function ToneReport({ open, onClose }: Props) {
  const { state } = useLabState();
  return <BriefSheet open={open} onClose={onClose} brief={useToneBrief(state)} />;
}

function AccuracyReport({ open, onClose }: Props) {
  const { data, list } = useCriteria("code");
  return data && (data.log || data.sim) ? <ReportSheet open={open} onClose={onClose} data={data} list={list} /> : null;
}

/**
 * «Отчёт для письма» of one check, the same from its section and from «Обзор»: tone of voice tells the team its brief
 * with the screen's number, accuracy its protocol of problems. Two checks are never in one report.
 */
export function CheckReport({ check, ...props }: Props & { check: Check }) {
  return check === "tone" ? <ToneReport {...props} /> : <AccuracyReport {...props} />;
}
