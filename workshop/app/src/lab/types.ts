export type Status = "PASS" | "FAIL" | "UNMEASURED" | "UNKNOWN" | "NOT_APPLICABLE" | "RUNNING";
export type Rule = { ruleId: string; rule: string; status: Status; reason: string; agentQuote: string; title?: string; review?: "agree" | "disagree" | null };
export type Metric = {
  accuracy: number | null; passed: number; failed: number; unmeasured: number; measured: number; total: number;
  secondJudge?: { model: string; checked: number; agree: number };
  repeats?: { scenarios: number; stable: number; attempts: number };
  human?: { reviewed: number; agree: number };
  personas?: Record<string, { accuracy: number | null; passed: number; measured: number }>;
};
export type Message = {
  role: "customer" | "agent"; text: string; fromLog?: boolean; rewritten?: boolean; ok?: boolean; status?: string; seconds?: number;
  options?: string[]; events?: { tool: string; article?: string }[];
};
export type Item = {
  cardId: string; name: string; topic: string; origin: string; status: Status; stage: string; conversation: Message[]; rules: Rule[];
  error: string | null; runId?: string; attempt?: number; persona?: string;
  second?: { model: string; status: string; rules?: Rule[] }; review?: "agree" | "disagree" | null; world?: boolean;
};
export type LabRun = {
  id: string; target: string; targetName: string; version: string; startedAt: string; finishedAt: string | null; status: string;
  metric: Metric | null; error: string | null; repeats?: number; items?: Item[]; label?: string; personas?: string[] | null; model?: string;
};
export type Criterion = { id: string; text: string; quote: string; condition?: string; acceptable?: string; sourceId?: string };
export type World = {
  organization: { name: string; inn: string; merchantName: string; address: string };
  terminals: { nameForClient: string; terminalId: string; stateCode: string }[];
  tools: Record<string, unknown>;
};
export type Card = {
  id: string; topic: string; name: string; situation: string; opening: string; criteria: Criterion[]; origin: string;
  sourceDialogueId: string; world?: World | null; openings?: Record<string, string>;
};
export type LogResult = {
  dialogueId: string; topicId: string; status: Status; rules: Rule[]; opening: string; runId?: string;
  second?: { model?: string; status: string; rules?: Rule[] } | null;
};
export type PatternExample = { dialogueId: string; reason: string; agentQuote: string; opening: string; url?: string };
export type Pattern = { rule: string; quote: string; topics: string[]; count: number; titles: string[]; examples: PatternExample[] };
export type Target = { id: string; name: string; kind: string; note: string; where: string; ready: boolean };
export type Persona = { id: string; name: string; note: string };
export type Settings = { prodUrl: string; epk: string[]; repo: string };
export type Source = { id: string; kind: string; origin: string; chars: number; rules: number };
export type Models = { via: string; main: string | null; second: string | null };
export type Check = { ok: boolean; error?: string; status?: string; text?: string; seconds?: number; version?: string };
export type Topic = { id: string; title: string; rules: Criterion[] };
export type Discover = {
  sampled: number; model: string; finishedAt: string; rulesSince?: string; topics: Topic[]; results: LogResult[];
  summary: {
    checked: number; failed: number; passed: number; unmeasured: number; patterns: Pattern[];
    secondJudge?: { model: string; checked: number; agree: number } | null;
  };
};
export type Job = {
  kind: string | null; running: boolean; error: string | null;
  progress: { message?: string; done?: number; total?: number; run?: string };
};
export type LabState = {
  job: Job;
  model: string;
  models: Models;
  settings: Settings;
  sources: Source[];
  logs: { total: number; file?: string | null; updatedAt?: string | null };
  discover: null | Discover;
  cards: null | { cards: Card[]; createdAt?: string };
  runs: LabRun[];
  targets: Target[];
  personas: Persona[];
};
export type Step = "criteria" | "dialogs" | "judge" | "checks" | "agent" | "logs";
