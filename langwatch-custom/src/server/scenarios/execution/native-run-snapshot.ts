import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { encrypt, decrypt } from "~/utils/encryption";
import {
  prefetchScenarioData,
  createDataPrefetcherDependencies,
  type PrefetchResult,
} from "./data-prefetcher";
import { ChildProcessJobDataSchema } from "./types";
import {
  sealPreparedRun,
  openPreparedRun,
  type QueuedRun,
} from "./frozen-run-contract";
let cachedBinary: { stamp: string; hash: string } | undefined;
const sdkBuild = () => {
  const binary = path.resolve("dist/server/scenario-child-process.cjs");
  const stat = statSync(binary);
  const stamp = stat.size + ":" + stat.mtimeMs;
  if (cachedBinary?.stamp !== stamp)
    cachedBinary = {
      stamp,
      hash: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    };
  return (
    (process.env.LANGWATCH_SCENARIO_SDK_SHA ?? "unrecorded") +
    ":" +
    cachedBinary.hash
  );
};
/** Runs before the native queued event is dispatched, for REST and the UI. */
export async function freezeQueuedRun<T extends QueuedRun>(
  command: T,
): Promise<T> {
  if (!command.target) throw new Error("Target is required before scheduling");
  const prepared = await prefetchScenarioData({
    context: {
      projectId: command.tenantId,
      scenarioId: command.scenarioId,
      scenarioRunId: command.scenarioRunId,
      batchRunId: command.batchRunId,
      setId: command.scenarioSetId,
      parameters: command.metadata?.parameters,
      secretParameters: command.secretParameters,
    },
    target: command.target as any,
    deps: createDataPrefetcherDependencies(),
  });
  if (!prepared.success)
    throw new Error("Run was not scheduled: " + prepared.error);
  return sealPreparedRun(command, prepared, encrypt, sdkBuild()) as T;
}
export function readFrozenRun(job: any): PrefetchResult | null {
  try {
    const prepared = openPreparedRun(job, decrypt, sdkBuild());
    if (!prepared) return null;
    return {
      ...prepared,
      data: ChildProcessJobDataSchema.parse(prepared.data),
    };
  } catch {
    return {
      success: false,
      error:
        "The scheduled measurement conditions could not be restored. No agent request was sent.",
    };
  }
}
