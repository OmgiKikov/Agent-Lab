#!/usr/bin/env python3
"""Small native queue/worker patches; retain upstream event and run storage."""
from pathlib import Path
import hashlib,json,subprocess
ROOT=Path(__file__).resolve().parent.parent
APP=ROOT/'langwatch/.local/app/platform/app'
def replace(relative,old,new,marker):
 p=APP/relative;s=p.read_text()
 if marker in s:return
 if old not in s:raise RuntimeError('Native patch anchor changed: '+relative)
 p.write_text(s.replace(old,new,1))
def apply():
 replace('src/server/api/routers/scenarios/simulation-runner.router.ts','import {','import { freezeQueuedRun } from "~/server/scenarios/execution/native-run-snapshot";\nimport {','import { freezeQueuedRun }')
 replace('src/server/api/routers/scenarios/simulation-runner.router.ts','await getApp().simulations.queueRun({','await getApp().simulations.queueRun(await freezeQueuedRun({','queueRun(await freezeQueuedRun(')
 p=APP/'src/server/api/routers/scenarios/simulation-runner.router.ts';s=p.read_text();old='      occurredAt: Date.now(),\n    });';new='      occurredAt: Date.now(),\n    }));'
 if new not in s:
  if old not in s:raise RuntimeError('Native queue closing anchor changed')
  p.write_text(s.replace(old,new,1))
 replace('src/server/app-layer/presets.ts','import {','import { freezeQueuedRun } from "~/server/scenarios/execution/native-run-snapshot";\nimport {','import { freezeQueuedRun }')
 replace('src/server/app-layer/presets.ts','queueSimulationRun: commands.simulations.queueRun,','queueSimulationRun: async (data) => commands.simulations.queueRun(await freezeQueuedRun(data)),','queueSimulationRun: async (data)')
 replace('src/server/scenarios/scenario.processor.ts','import {','import { readFrozenRun } from "./execution/native-run-snapshot";\nimport {','import { readFrozenRun }')
 replace('src/server/scenarios/scenario.processor.ts','const prefetchResult = await prefetchScenarioData({','const prefetchResult = readFrozenRun(jobData) ?? await prefetchScenarioData({','readFrozenRun(jobData) ??')
 replace('src/server/scenarios/execution/types.ts','export const ScenarioConfigSchema = z.object({','export const ScenarioConfigSchema = z.object({\n  version: z.number().int().optional(),','version: z.number().int().optional()')
 replace('src/server/scenarios/execution/data-prefetcher.ts','    labels: string[];','    labels: string[];\n    version?: number;','    version?: number;')
 replace('src/server/scenarios/execution/data-prefetcher.ts','      id: scenario.id,','      id: scenario.id,\n      version: scenario.version,','      version: scenario.version,')
 replace('src/server/scenarios/execution/scenario-child-process.ts','          targetReferenceId: target.referenceId,','          targetReferenceId: target.referenceId,\n          scenarioVersion: scenario.version,','          scenarioVersion: scenario.version,')
 replace('src/server/scenarios/execution/scenario-child-process.ts','import {','import { createCustomerAdapter } from \"./customer-adapter\";\nimport {','import { createCustomerAdapter }')
 replace('src/server/scenarios/execution/scenario-child-process.ts','ScenarioRunner.userSimulatorAgent({ model: simulatorModel }),','createCustomerAdapter(simulatorModel, parameters),','createCustomerAdapter(simulatorModel, parameters)')
 # Preserve criterion evidence in the actual installed SDK, both entry points.
 canonical=APP/'src/server/scenarios/execution/measurement-outcome.ts'
 compiler="const fs=require('node:fs');const es=require('./node_modules/esbuild');process.stdout.write(es.transformSync(fs.readFileSync(process.argv[1],'utf8'),{loader:'ts',format:'cjs'}).code)"
 compiled=subprocess.check_output(['/opt/homebrew/bin/node','-e',compiler,str(canonical)],cwd=APP,text=True)
 capsule='var __nativeMeasurement = (() => { const module={exports:{}}; const exports=module.exports; '+compiled+'; return module.exports; })();\n'
 sdkroot=(APP/'node_modules/@langwatch/scenario').resolve()
 for entry in ['dist/index.js','dist/index.mjs']:
  file=sdkroot/entry;text=file.read_text()
  if 'var __nativeMeasurement =' in text:
   begin=text.index('var __nativeMeasurement =');end=text.index('var criterionToParamName =',begin)
   text=text[:begin]+capsule+text[end:];file.write_text(text)
  if 'var __nativeMeasurement =' not in text:
   marker='var criterionToParamName = (criterion) => {'
   start=text.index(marker);finish=text.index('};',start)+2
   text=text[:start]+capsule+'var criterionToParamName = (criterion,index) => __nativeMeasurement.criterionKey(criterion,index);'+text[finish:]
   start=text.index('          const criteriaValues = Object.values(criteriaArgs);')
   finish=text.index('          this.logger.debug("finish_test result", result);',start)
   text=text[:start]+'          const result = {...__nativeMeasurement.evaluateRequiredCriteria(criteria,criteriaArgs), reasoning};\n'+text[finish:]
   text=text.replace('verdict: result?.success ? "success" /* SUCCESS */ : "failure" /* FAILURE */,','verdict: result?.verdict ?? (result?.success ? "success" /* SUCCESS */ : "failure" /* FAILURE */),',1)
   text=text.replace('        unmetCriteria: result?.unmetCriteria ?? [],','        unmetCriteria: result?.unmetCriteria ?? [],\n        inconclusiveCriteria: result?.inconclusiveCriteria ?? [],',1)
   text=text.replace('  unmetCriteria: import_zod.z.array(import_zod.z.string()),','  unmetCriteria: import_zod.z.array(import_zod.z.string()),\n  inconclusiveCriteria: import_zod.z.array(import_zod.z.string()).optional(),',1)
   file.write_text(text)
 for path in ['src/server/event-sourcing/pipelines/simulation-processing/schemas/shared.ts','src/server/scenarios/schemas/event-schemas.ts']:
  old='  unmetCriteria: z.array(z.string()).default([]),' if path.endswith('/shared.ts') else '  unmetCriteria: z.array(z.string()),'
  replace(path,old,old+'\n  inconclusiveCriteria: z.array(z.string()).default([]),','  inconclusiveCriteria:')
 replace('src/server/scenarios/execution/scenario-child-process.ts','      success: result.success,','      success: true, // The SDK verdict describes the agent; stdout describes execution.','success: true, // The SDK verdict')
 child='src/server/scenarios/execution/scenario-child-process.ts'
 replace(child,'import { createCustomerAdapter } from "./customer-adapter";','import { createCustomerAdapter } from "./customer-adapter";\nimport { parseCustomerContract } from "./customer-contract";','import { parseCustomerContract }')
 replace(child,'      ...(scenario.maxTurns != null && { maxTurns: scenario.maxTurns }),','      ...(parseCustomerContract(parameters.customer_contract) ? {maxTurns: parseCustomerContract(parameters.customer_contract)!.maxCustomerTurns} : scenario.maxTurns != null ? {maxTurns: scenario.maxTurns} : {}),','maxTurns: parseCustomerContract(parameters.customer_contract)')
 # Exhausting a dialogue is not evidence that every business criterion failed.
 for entry in ['dist/index.js','dist/index.mjs']:
  file=sdkroot/entry;text=file.read_text();text=text.replace('unmetCriteria: this.getJudgeAgent()?.criteria ?? []','unmetCriteria: [],\n      inconclusiveCriteria: this.getJudgeAgent()?.criteria ?? [],\n      verdict: "inconclusive"');file.write_text(text)
 # Unknown evidence remains a terminal, unmeasured result using the existing
 # ERROR execution status. The business verdict remains inconclusive.
 finish='src/server/event-sourcing/pipelines/simulation-processing/commands/finishRun.command.ts'
 replace(finish,'    const eventData: SimulationRunFinishedEventData = {','    if (results?.verdict === "inconclusive" && !results.error && data.status !== "CANCELLED") data.status = "ERROR";\n\n    const eventData: SimulationRunFinishedEventData = {','results?.verdict === "inconclusive" && !results.error')
 fold='src/server/event-sourcing/pipelines/simulation-processing/projections/simulationRunState.foldProjection.ts'
 projection=APP/fold;projection.write_text(projection.read_text().replace('Metadata: {...state.Metadata, nativeMeasurement: {inconclusiveCriteria: results?.inconclusiveCriteria ?? []}},','Metadata: storedMetadata({...JSON.parse(state.Metadata ?? "{}"), nativeMeasurement: {inconclusiveCriteria: results?.inconclusiveCriteria ?? []}}),'))
 replace(fold,'      UnmetCriteria: results?.unmetCriteria ?? [],','      UnmetCriteria: results?.unmetCriteria ?? [],\n      Metadata: storedMetadata({...JSON.parse(state.Metadata ?? "{}"), nativeMeasurement: {inconclusiveCriteria: results?.inconclusiveCriteria ?? []}}),','nativeMeasurement: {inconclusiveCriteria:')
 ingest='src/app/api/scenario-events/[[...route]]/app.ts'
 replace(ingest,'            unmetCriteria: event.results.unmetCriteria,','            unmetCriteria: event.results.unmetCriteria,\n            inconclusiveCriteria: event.results.inconclusiveCriteria,','inconclusiveCriteria: event.results.inconclusiveCriteria')
 mapper='src/server/simulations/simulation-run.mappers.ts'
 replace(mapper,'    results,','    results: results ? {...results, inconclusiveCriteria: (metadata as any)?.nativeMeasurement?.inconclusiveCriteria ?? []} : null,','inconclusiveCriteria: (metadata as any)')
 labels='src/components/suites/format-run-status-label.ts'
 replace(labels,'  unmetCriteria: string[];','  unmetCriteria: string[];\n  inconclusiveCriteria?: string[];\n  verdict?: string;','  inconclusiveCriteria?: string[];')
 replace(labels,'[ScenarioRunStatus.ERROR]: "Failed",','[ScenarioRunStatus.ERROR]: "Ошибка запуска",','[ScenarioRunStatus.ERROR]: "Ошибка запуска"')
 replace(labels,'  const label = STATUS_LABELS[status];','  if (results?.verdict === "inconclusive") return "Недостаточно данных";\n  const label = STATUS_LABELS[status];','results?.verdict === "inconclusive"')
 replace(labels,'  const total = met + results.unmetCriteria.length;','  const total = met + results.unmetCriteria.length + (results.inconclusiveCriteria?.length ?? 0);','(results.inconclusiveCriteria?.length ?? 0)')
 # ERROR is no longer counted as a proven business violation, in the shared
 # categorizer used by native UI and CSV. A partial cohort has no quality %.
 category='src/server/scenarios/scenario-run-category.ts'
 replace(category,'  | "success"','  | "unmeasured"\n  | "success"','  | "unmeasured"')
 replace(category,'    case ScenarioRunStatus.ERROR:\n    case ScenarioRunStatus.FAILED:','    case ScenarioRunStatus.ERROR:\n      return "unmeasured";\n    case ScenarioRunStatus.FAILED:','return "unmeasured";')
 history='src/components/suites/run-history-transforms.ts'
 replace(history,'  let stalledCount = 0;','  let stalledCount = 0;\n  let unmeasuredCount = 0;','  let unmeasuredCount = 0;')
 replace(history,'      case "success":','      case "unmeasured":\n        unmeasuredCount++;\n        break;\n      case "success":','        unmeasuredCount++;')
 replace(history,'passedCount + failedCount + stalledCount + cancelledCount;','passedCount + failedCount + stalledCount + cancelledCount + unmeasuredCount;','cancelledCount + unmeasuredCount;')
 replace(history,'    settledCount > 0\n','    unmeasuredCount > 0 || completedCount < totalCount ? null : settledCount > 0\n','unmeasuredCount > 0 || completedCount < totalCount')
 replace(history,'  passedCount: number;','  passedCount: number;\n  unmeasuredCount?: number;','  unmeasuredCount?: number;')
 replace(history,'  return ScenarioRunStatus.SUCCESS;','  if ((summary.unmeasuredCount ?? 0) > 0) return ScenarioRunStatus.ERROR;\n  return ScenarioRunStatus.SUCCESS;','summary.unmeasuredCount ?? 0')
 replace(history,'    passRate,\n    passedCount,','    passRate,\n    unmeasuredCount,\n    passedCount,','    unmeasuredCount,')
 api='src/app/api/simulation-runs/[[...route]]/app.ts'
 replace(api,'    scenarioVersion: metadata?.langwatch?.scenarioVersion ?? null,','    scenarioVersion: metadata?.frozenRun?.scenario?.version ?? metadata?.langwatch?.scenarioVersion ?? null,\n    frozenManifest: metadata?.frozenRun ?? metadata?.langwatch?.frozenRun ?? null,','    frozenManifest:')
 drawer='src/components/agent-testing/drawers/RunDrawerContent.tsx'
 replace(drawer,'declaredCriteria: detail.scenarioData?.criteria ?? [],','declaredCriteria: (scenarioState as any).metadata?.frozenRun?.scenario?.criteria ?? detail.scenarioData?.criteria ?? [],','metadata?.frozenRun?.scenario?.criteria')
 # Partial evidence must also remain partial in native details and CSV.
 metrics='src/components/simulations/simulation-console/MetricsSummary.tsx'
 replace(metrics,'  const totalCriteria = metCount + unmetCount;','  const unknownCount = results?.inconclusiveCriteria?.length ?? 0;\n  const totalCriteria = metCount + unmetCount + unknownCount;','  const unknownCount =')
 replace(metrics,'    totalCriteria > 0 ?','    unknownCount > 0 || results?.verdict === "inconclusive" ? "Недостаточно данных" : totalCriteria > 0 ?','unknownCount > 0 || results?.verdict')
 replace(metrics,'          {successRate}%','          {successRate}{unknownCount === 0 && results?.verdict !== "inconclusive" ? "%" : ""}','{successRate}{unknownCount')
 details='src/components/simulations/simulation-console/CriteriaDetails.tsx'
 replace(details,'      {/* Reasoning */}','      {(results.inconclusiveCriteria?.length ?? 0) > 0 && <Box><Text color="yellow.300">Недостаточно данных ({results.inconclusiveCriteria!.length}):</Text>{results.inconclusiveCriteria!.map((criterion, index) => <Text key={index} color="yellow.300">• {criterion}</Text>)}</Box>}\n      {/* Reasoning */}','Недостаточно данных ({results.inconclusiveCriteria')
 chip='src/components/simulations/RunCriteriaChip.tsx'
 replace(chip,'  unmetCriteria,\n}: {','  unmetCriteria,\n  inconclusiveCriteria = [],\n}: {','  inconclusiveCriteria = [],')
 replace(chip,'  unmetCriteria: string[];','  unmetCriteria: string[];\n  inconclusiveCriteria?: string[];','  inconclusiveCriteria?: string[];')
 replace(chip,'  const total = met + unmetCriteria.length;','  const total = met + unmetCriteria.length + inconclusiveCriteria.length;','+ inconclusiveCriteria.length;')
 replace(chip,'tone={unmetCriteria.length === 0 ? "green" : "red"}','tone={inconclusiveCriteria.length ? "neutral" : unmetCriteria.length === 0 ? "green" : "red"}','tone={inconclusiveCriteria.length')
 replace(chip,'            {rate}% of success criteria met','            {inconclusiveCriteria.length ? `${inconclusiveCriteria.length} criteria have insufficient evidence` : `${rate}% of success criteria met`}','criteria have insufficient evidence')
 for caller in ['src/components/agent-testing/drawers/RunDrawerHeaderBand.tsx']:
  replace(caller,'unmetCriteria={scenarioState.results.unmetCriteria ?? []}','unmetCriteria={scenarioState.results.unmetCriteria ?? []}\n          inconclusiveCriteria={scenarioState.results.inconclusiveCriteria ?? []}','inconclusiveCriteria={scenarioState.results')
 replace('src/components/simulations/ScenarioRunDetailDrawer.tsx','                          scenarioState.results.unmetCriteria ?? []\n                        }','                          scenarioState.results.unmetCriteria ?? []\n                        }\n                        inconclusiveCriteria={scenarioState.results.inconclusiveCriteria ?? []}','inconclusiveCriteria={scenarioState.results')
 csv='src/server/export/scenario-runs/csv-serializer.ts'
 replace(csv,'  "unmet_criteria_count",','  "unmet_criteria_count",\n  "inconclusive_criteria_count",','  "inconclusive_criteria_count",')
 replace(csv,'["met_criteria", "unmet_criteria"]','["met_criteria", "unmet_criteria", "inconclusive_criteria"]','"inconclusive_criteria"]')
 replace(csv,'String(results?.unmetCriteria?.length ?? 0),','String(results?.unmetCriteria?.length ?? 0),\n    String(results?.inconclusiveCriteria?.length ?? 0),','String(results?.inconclusiveCriteria')
 replace(csv,'    jsonArray(run.results?.unmetCriteria),','    jsonArray(run.results?.unmetCriteria),\n    jsonArray(run.results?.inconclusiveCriteria),','jsonArray(run.results?.inconclusiveCriteria)')
 replace(csv,'const push = (criterion: string, met: boolean)','const push = (criterion: string, met: boolean | "UNKNOWN")','boolean | "UNKNOWN"')
 replace(csv,'      push(criterion, false);','      push(criterion, false);\n    for (const criterion of run.results?.inconclusiveCriteria ?? []) push(criterion, "UNKNOWN");','push(criterion, "UNKNOWN")')
 config='src/components/simulations/scenario-run-status-config.ts'
 replace(config,'  [ScenarioRunStatus.ERROR]: {\n    colorPalette: "red",\n    label: "failed",','  [ScenarioRunStatus.ERROR]: {\n    colorPalette: "yellow",\n    label: "Не подтверждено",','label: "Не подтверждено"')
 repository='src/server/app-layer/simulations/repositories/simulation.clickhouse.repository.ts'
 replace(repository,"countIf(Status IN ('FAILED','FAILURE','ERROR','STALLED','CANCELLED')) AS FailCount,","countIf(Status IN ('FAILED','FAILURE')) AS FailCount,","countIf(Status IN ('FAILED','FAILURE')) AS FailCount,")
 replace(repository,"countIf(Status NOT IN ('IN_PROGRESS', 'PENDING', 'QUEUED', 'RUNNING')) AS SettledCount,","count() AS SettledCount, -- complete cohort: pending and unknown also require measurement","complete cohort: pending and unknown")
 sidebar='src/components/suites/SuiteSidebar.tsx'
 replace(sidebar,'  const passRate = totalCount > 0 ? (passedCount / totalCount) * 100 : null;','  const passRate = passedCount + failedCount < totalCount ? null : totalCount > 0 ? (passedCount / totalCount) * 100 : null;','passedCount + failedCount < totalCount')
 # The active SDK artifact, rather than a separately cloned newer SDK.
 package=json.loads((APP/'package.json').read_text());spec=package['dependencies']['@langwatch/scenario']
 if not spec.startswith('file:'):raise RuntimeError('SDK artifact is not a pinned local file')
 sdk=APP/spec[5:];digest=hashlib.sha256(sdk.read_bytes()+canonical.read_bytes()+Path(__file__).read_bytes()).hexdigest()
 envfile=ROOT/'langwatch/.local/.env';lines=envfile.read_text().splitlines();lines=[l for l in lines if not l.startswith('LANGWATCH_SCENARIO_SDK_SHA=')];lines.append('LANGWATCH_SCENARIO_SDK_SHA='+digest);envfile.write_text('\n'.join(lines)+'\n')
 return digest
if __name__=='__main__':print('Native queue contract applied, SDK:',apply()[:12])
