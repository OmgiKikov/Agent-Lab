/**
 * The two checks of the real conversations of the export: tone of voice by a person's rules of
 * communication, accuracy by the criteria read from the agent's code. Each has its own criteria, result and answers.
 */
export type Check = "tone" | "code";
export type Status = "PASS" | "FAIL" | "UNMEASURED" | "UNKNOWN" | "NOT_APPLICABLE" | "RUNNING";
export type Rule = {
  ruleId: string;
  rule: string;
  status: Status;
  reason: string;
  agentQuote: string;
  title?: string;
  review?: "agree" | "disagree" | null;
};
export type Metric = {
  accuracy: number | null;
  passed: number;
  failed: number;
  unmeasured: number;
  measured: number;
  total: number;
  secondJudge?: { model: string; checked: number; agree: number };
  repeats?: { scenarios: number; stable: number; attempts: number };
  human?: { reviewed: number; agree: number };
  personas?: Record<string, { accuracy: number | null; passed: number; measured: number }>;
  /** Scenario sets (representative, regression, stress), each measured on its own; the representative one also
   * weighted by how many conversations of the export each of its cards stands for, unless a scenario of its sample has
   * no card (incomplete). */
  sets?: Record<
    string,
    { accuracy: number | null; passed: number; measured: number; weighted?: number | null; incomplete?: boolean }
  >;
};
/** A call of the agent's tool as the service recorded it. */
export type ToolEvent = { tool: string; article?: string; query?: string; arguments?: unknown; seconds?: number };
export type Message = {
  role: "customer" | "agent";
  text: string;
  fromLog?: boolean;
  rewritten?: boolean;
  ok?: boolean;
  status?: string;
  seconds?: number;
  options?: string[];
  events?: ToolEvent[];
};
/**
 * The details of its organization the customer was told in a conversation: from the scenario's world in the mocks,
 * the stand's own fixtures, or the organization of the conversation's EPK on the IFT stand. Not known: the customer
 * was told it has none at hand (the fixtures could not be read, the EPK is not described, or there is no EPK).
 */
export type Stop = "resolved" | "instruction" | "gave_up" | "ended" | "handed_off" | "budget";
export type CustomerDetails = { from: "world" | "fixtures" | "epk"; epk?: string | null; known: boolean; text: string };
export type Item = {
  cardId: string;
  name: string;
  topic: string;
  origin: string;
  status: Status;
  stage: string;
  conversation: Message[];
  rules: Rule[];
  error: string | null;
  runId?: string;
  attempt?: number;
  persona?: string;
  second?: { model: string; status: string; rules?: Rule[] };
  review?: "agree" | "disagree" | null;
  world?: boolean;
  /** What the customer could say of its organization, and whose bank it came from (backend: customer_details). */
  customerDetails?: CustomerDetails;
  /** Why the conversation stopped: the customer's reason, a handoff, or the budget of turns (backend: play). */
  stop?: Stop | null;
  /** The criteria frozen when the conversation was played: a criterion that never applied in it is named only here. */
  criteria?: Criterion[];
};
export type LabRun = {
  id: string;
  target: string;
  targetName: string;
  version: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  metric: Metric | null;
  error: string | null;
  repeats?: number;
  items?: Item[];
  label?: string;
  personas?: string[] | null;
  model?: string;
  /** The check whose scenarios it played, from the deck at the start; the summaries in /api/state always have it. */
  check?: Check;
  /** Grows with every change of the run: a conversation played or judged again, a person's answer. */
  revision?: number;
  /** When the run changed last; older services have no such field. */
  updatedAt?: string;
};
/** A run as /api/state lists it: its summary, without the conversations, and always with its check. */
export type RunSummary = LabRun & { check: Check };
export type Criterion = {
  id: string;
  name?: string;
  text: string;
  quote: string;
  condition?: string;
  acceptable?: string;
  sourceId?: string;
  clarifications?: string[];
};
export type World = {
  organization: { name: string; inn: string; merchantName: string; address: string };
  terminals: { nameForClient: string; terminalId: string; stateCode: string }[];
  tools: Record<string, unknown>;
};
/**
 * The profile of a card's customer (backend/lab/domain/cards.py, customer): what they know and when they say it,
 * what they already tried and what trying gives, how they reacted to the agent; every item cites its customer message
 * (n) by a quote of the log. Cards built before the profile have none of it, only the situation.
 */
export type Knowledge = {
  text: string;
  access: "knows" | "believes" | "does_not_know";
  disclose: "opening" | "when_relevant" | "on_request";
  n: number;
  quote: string;
};
export type Observation = {
  action: string;
  result: string;
  when: "before" | "during";
  disclose: Knowledge["disclose"];
  n: number;
  quote: string;
};
export type Reaction = {
  trigger: string;
  actions: string[];
  reveals: string[];
  agentQuote: string;
  n: number;
  quote: string;
};
/** What the code found in the text the simulator reads (cards.audit): empty lists are clean. */
export type Audit = { agentWords: string[]; criteriaWords: string[]; goalAhead: string[] };
export type Card = {
  id: string;
  topic: string;
  name: string;
  situation: string;
  goal?: { task: string; object: string };
  knowledge?: Knowledge[];
  notEstablished?: string[];
  observations?: Observation[];
  reactions?: Reaction[];
  checks?: { audit?: Audit };
  opening: string;
  criteria: Criterion[];
  origin: string;
  sourceDialogueId: string;
  world?: World | null;
  openings?: Record<string, string>;
  /** The sets the card is in: representative, stress. */
  sets?: string[];
  /** How many conversations of the export a card of the representative set stands for. */
  weight?: number | null;
  /** The business scenario of the catalog the card's conversation is in. */
  scenario?: { id: string; title: string; categoryId: string; category: string } | null;
};
export type LogResult = {
  error?: string | null;
  dialogueId: string;
  topicId: string;
  status: Status;
  rules: Rule[];
  opening: string;
  runId?: string;
  second?: { model?: string; status: string; rules?: Rule[] } | null;
};
export type PatternExample = { dialogueId: string; reason: string; agentQuote: string; opening: string; url?: string };
export type Pattern = {
  rule: string;
  quote: string;
  topics: string[];
  count: number;
  titles: string[];
  examples: PatternExample[];
};
export type Target = { id: string; name: string; kind: string; note: string; where: string; ready: boolean };
export type Persona = { id: string; name: string; note: string };
/** The organization of an EPK on the IFT stand as a person described it: what the synthetic customer can name. */
export type Client = { name: string; inn: string; terminals: string[] };
export type Settings = { prodUrl: string; epk: string[]; clients: Record<string, Client>; repo: string };
export type Source = { id: string; kind: string; origin: string; chars: number; rules: number; sha256?: string | null };
/**
 * The models as /api/state describes them (backend/lab/models/__init__.py, describe): where the conversations go, where the second
 * check's go when elsewhere, and why the models cannot be used now: the bank's gateway, set up, does not work, or
 * OpenRouter has no key.
 */
export type Models = {
  via: string;
  main: string | null;
  second: string | null;
  secondVia?: string | null;
  problem?: string | null;
};
/** What one try of a connection or a model answered. */
export type Probe = { ok: boolean; error?: string; status?: string; text?: string; seconds?: number; version?: string };
export type Topic = { id: string; title: string; rules: Criterion[] };
export type Discover = {
  checkId?: string;
  criteriaFingerprint?: string;
  purpose?: string;
  criteriaRevision?: string;
  sampled: number;
  /** Accuracy: the sampled conversations that fell into no topic, so no criterion applied to them. */
  unassigned?: number;
  model: string;
  finishedAt: string;
  rulesSince?: string;
  /** What the criteria were collected from: the agent's code for accuracy, with how many criteria each gave. */
  sources?: Source[];
  topics: Topic[];
  results: LogResult[];
  summary: {
    measured: number;
    checked: number;
    failed: number;
    passed: number;
    unmeasured: number;
    /** The recurring errors: in the result itself (GET /api/checks/{check}), not in its brief in the state. */
    patterns?: Pattern[];
    secondJudge?: { model: string; checked: number; agree: number } | null;
  };
};
/** The scenarios, built from the errors of one check and remembering it. */
/**
 * The deck's checks in counts (backend/lab/domain/scenarios.py, checked): cards whose text for the customer copies the
 * agent's words or the criteria, or names in the goal what the customer said later; and how customers answered when
 * the agent asked for an identifier, by action.
 */
export type DeckChecks = {
  cards: number;
  agentWords: number;
  criteriaWords: number;
  goalAhead: number;
  identifierAnswers: Record<string, number>;
};
export type Deck = { check: Check; cards: Card[]; createdAt?: string; checks?: DeckChecks };
export type Job = {
  kind: string | null;
  running: boolean;
  error: string | null;
  /** `check`: the check a proposal of which errors are serious is for (task `severity`, lab/severity). */
  progress: { message?: string; done?: number; total?: number; run?: string; check?: Check };
  /** When the task started: tells one task from the next of the same kind. Older services have no such field. */
  startedAt?: string | null;
};
/**
 * A check's result with people's answers taken in, counted by the service from the result's rows with the answers on
 * them. A conversation is «с ошибкой с учётом ответов» when it
 * keeps an error a person did not take back, or a person found the error the check missed there. The denominator stays
 * the check's: the conversations it could check. It never stands in for the check's own number, is never compared
 * between checks and never enters «было → стало».
 */
export type Answers = {
  /** The check's own count: the conversations it could check, and those it found an error in. */
  measured: number;
  failed: number;
  /** The same conversations with an error, people's answers taken in. */
  counted: number;
  /** The errors the check found (one criterion in one conversation), and people's «да» and «нет» on them. */
  errors: number;
  confirmed: number;
  removed: number;
  /** The verdicts «без ошибки» people answered, and in how many they found the error the check missed. */
  clean: number;
  missed: number;
};

/**
 * A check's result in brief, as /api/state gives it every 1.5 s: everything but the verdicts of its conversations and
 * the recurring errors, with how many conversations it judged and its count with people's answers. The verdicts come
 * from the result itself (lab/checks, useResult).
 */
export type ResultBrief = ResultHead & { conversations: number; answers: Answers };

/** What a result and its brief share: everything but the verdicts on the conversations. */
export type ResultHead = Omit<Discover, "results">;

export type LabState = {
  toneOfVoice?: ToneDraft | null;
  job: Job;
  model: string;
  models: Models;
  settings: Settings;
  sources: Source[];
  /**
   * When the agent's code was read last and from which folder, as the person wrote it; null before the first read.
   * `overBudget`: where the prompts are that the read found and left out of the criteria planner's budget
   * (sources.MAX_TOTAL); older records have no such field.
   */
  sourcesRead?: { readAt: string; repo: string; overBudget?: string[] } | null;
  logs: { total: number; file?: string | null; updatedAt?: string | null };
  /** The result of each check in brief, or null: tone of voice and accuracy never replace each other. */
  checks: Record<Check, ResultBrief | null>;
  /**
   * The serious criteria, per check, by their key (the problem's id, problems.rule_key): by a person's decision, else
   * by the automatic check's proposal; without either an error is minor. Older
   * services have no such field.
   */
  severity?: Record<Check, string[]>;
  /**
   * Changes with any decision or proposal of severity, also one that leaves the same criteria serious (a person
   * confirmed a proposal: whose decision it is changed). Older services have no such field.
   */
  severityStamp?: string;
  /**
   * Changes with every answer given or taken back, on a check's result or on a run, in this tab or any other: the
   * results, the problems and an open run are fetched again by it. Older services have none.
   */
  reviewsStamp?: string;
  cards: null | Deck;
  runs: RunSummary[];
  targets: Target[];
  personas: Persona[];
};

export type ToneCriterion = Criterion & { name: string; condition: string; acceptable: string };
export type ToneDraft = {
  revision: string;
  createdAt: string;
  sourceSha256: string;
  criteria: ToneCriterion[];
  model: string | null;
};

/** A tool the agent called during its turn, as the service logged it. */
export type ToolCall = { tool: string; article?: string; query?: string; arguments?: unknown; seconds?: number };
/** One turn of a conversation: who spoke, the logged text, the buttons sent, the tools called, and how the turn ended. */
export type Turn = {
  role: "customer" | "agent";
  text: string;
  /** The buttons a simulated agent sent with its reply, by their words; an export writes its own into the text. */
  options?: string[];
  events?: ToolCall[];
  ok?: boolean;
  status?: string;
  seconds?: number;
};
