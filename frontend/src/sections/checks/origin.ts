import type { Check } from "../../app/links";
import { useDatasets, type Dataset } from "../../lab/datasets";
import { useLaunches, type Launch } from "../../lab/launches";
import { useLabState } from "../../lab/LabProvider";
import { shownName } from "../data/DatasetInfo";

/** What a check of the recorded answers was made of, in the words its screens use. */
export type Origin = {
  /** The launch whose recorded answers the check judged; none for a check older than launches. */
  launch?: Launch;
  /** Its dataset as people call it: the name, else the file without its extension; empty when nothing says which. */
  dataset: string;
  /**
   * The version of the agent whose answers the check judged: the dataset's, else the one its launch was told. A launch
   * that only asked the live agent keeps its own: those answers are the stand's, not the dataset's.
   */
  version: string;
};

/**
 * A dataset's file as the dataset is called when nothing else names it: without its extension. The summary names its
 * dataset this way too, before the list of datasets has come.
 */
export const fileName = (file: string) => file.replace(/\.(jsonl|json|csv|xlsx)$/i, "");

/**
 * The origin of a check: by its launch, else by the dataset (`datasetId`) or the file it is known to be of — the
 * current result is of the dataset in use, an older saved check names at most its file.
 */
export function originOf(
  launch: Launch | undefined,
  datasets: Dataset[],
  datasetId?: string | null,
  file?: string | null,
): Origin {
  const id = launch?.dataset?.datasetId ?? datasetId;
  const dataset = id ? datasets.find((d) => d.id === id) : undefined;
  const ownVersion = launch && !launch.modes.dataset;
  return {
    launch,
    dataset: dataset ? shownName(dataset) : fileName(launch?.dataset?.name || launch?.dataset?.file || file || ""),
    version: (ownVersion ? "" : dataset?.agentVersion) || launch?.agentVersion || "",
  };
}

/**
 * The origin of each check of the recorded answers of a check, by its id: its launch is the one that checked them
 * (`modes.dataset.checkId`).
 */
export function useOrigins(check: Check) {
  const { state } = useLabState();
  const launches = useLaunches(check, `${state?.job.id}-${state?.job.running}`);
  const datasets = useDatasets();
  return (checkId: string | null | undefined, datasetId?: string | null, file?: string | null) =>
    originOf(
      checkId ? launches.data?.launches.find((l) => l.modes.dataset?.checkId === checkId) : undefined,
      datasets.data?.datasets ?? [],
      datasetId,
      file,
    );
}
