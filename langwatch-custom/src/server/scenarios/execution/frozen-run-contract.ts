import { createHash } from "node:crypto";

export const FROZEN_SLOT = "__native_frozen_execution_v1";
export const FROZEN_TARGET_PREFIX = "__frozen_v1__";
export type QueuedRun = {
  tenantId: string;
  scenarioId: string;
  scenarioRunId: string;
  batchRunId: string;
  scenarioSetId: string;
  target?: { type: string; referenceId: string };
  metadata?: Record<string, any>;
  secretParameters?: Record<string, string>;
  [key: string]: unknown;
};
type Prepared = {
  success: true;
  data: any;
  telemetry: { endpoint: string; apiKey: string };
};
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function modelSettings(params: any) {
  return Object.fromEntries(
    [
      "model",
      "temperature",
      "top_p",
      "seed",
      "max_tokens",
      "max_completion_tokens",
      "reasoning_effort",
    ]
      .filter((key) => params?.[key] !== undefined)
      .map((key) => [key, params[key]]),
  );
}
/** The public receipt contains measurement conditions, never credentials. */
export function sealPreparedRun(
  command: QueuedRun,
  prepared: Prepared,
  encrypt: (value: string) => string,
  sdkBuild: string,
) {
  if (!command.target) throw new Error("A frozen run needs a target");
  const manifest = {
    schemaVersion: 1,
    createdAt: Date.now(),
    sdkBuild,
    scenario: prepared.data.scenario,
    parameters: prepared.data.parameters,
    target: { ...command.target, buildVersion: { status: "unknown" as const } },
    models: {
      simulator: modelSettings(prepared.data.simulatorModelParams),
      judge: modelSettings(prepared.data.judgeModelParams),
      agent: modelSettings(prepared.data.modelParams),
    },
    fixtureVersion: { status: "unknown" as const },
    pricing: { status: "unknown" as const },
  };
  const receipt = { ...manifest, hash: digest(manifest) };
  const envelope = JSON.stringify({
    identity: {
      projectId: command.tenantId,
      scenarioId: command.scenarioId,
      scenarioRunId: command.scenarioRunId,
      batchRunId: command.batchRunId,
      setId: command.scenarioSetId,
    },
    receipt,
    prepared,
  });
  return {
    ...command,
    // An old worker cannot resolve this id and therefore cannot silently run
    // the live scenario/target instead of this encrypted snapshot.
    target: {
      ...command.target,
      referenceId: FROZEN_TARGET_PREFIX + command.target.referenceId,
    },
    metadata: {
      ...command.metadata,
      frozenRun: receipt,
      langwatch: {
        ...command.metadata?.langwatch,
        scenarioVersion:
          prepared.data.scenario.version ??
          command.metadata?.langwatch?.scenarioVersion,
        frozenRun: receipt,
      },
    },
    secretParameters: {
      ...command.secretParameters,
      [FROZEN_SLOT]: encrypt(envelope),
    },
  };
}
export function openPreparedRun(
  job: {
    projectId: string;
    scenarioId: string;
    scenarioRunId: string;
    batchRunId: string;
    setId: string;
    target: { referenceId: string };
    secretParameters?: Record<string, string>;
  },
  decrypt: (value: string) => string,
  sdkBuild: string,
): Prepared | null {
  const ciphertext = job.secretParameters?.[FROZEN_SLOT];
  if (!ciphertext) {
    if (job.target.referenceId.startsWith(FROZEN_TARGET_PREFIX))
      throw new Error("Frozen execution payload is missing");
    return null;
  }
  const value = JSON.parse(decrypt(ciphertext));
  for (const key of [
    "projectId",
    "scenarioId",
    "scenarioRunId",
    "batchRunId",
    "setId",
  ] as const) {
    if (value.identity?.[key] !== job[key])
      throw new Error("Frozen run identity mismatch");
  }
  const { hash, ...manifest } = value.receipt ?? {};
  if (manifest.schemaVersion !== 1 || digest(manifest) !== hash)
    throw new Error("Frozen run receipt is invalid");
  if (manifest.sdkBuild !== sdkBuild)
    throw new Error(
      "Scenario SDK changed after scheduling; run is not measured",
    );
  if (value.prepared?.success !== true)
    throw new Error("Invalid frozen execution payload");
  return value.prepared;
}
