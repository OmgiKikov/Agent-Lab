import { z } from "zod";

export const sourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  content: z.string(),
  kind: z.enum(["prompt", "knowledge"]),
});
export const ruleSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(2000),
  sourceId: z.string(),
  quote: z.string().min(8).max(2500),
  condition: z.string().max(2000),
  acceptable: z.string().max(2000),
  observation: z.enum(["reply", "tool", "state"]),
  approved: z.boolean().default(false),
});
export const planSchema = z.object({
  topics: z
    .array(
      z.object({
        id: z.string(),
        title: z.string().min(1).max(160),
        dialogueIds: z.array(z.string()).max(48),
        rules: z.array(ruleSchema).max(6),
        gap: z.string().max(2000).optional(),
      }),
    )
    .max(12),
});
export const verdictSchema = z.object({
  rules: z
    .array(
      z.object({
        ruleId: z.string(),
        status: z.enum(["PASS", "FAIL", "UNKNOWN", "NOT_APPLICABLE"]),
        reason: z.string().max(3000),
        agentQuote: z.string().max(3000),
        title: z.string().max(180),
      }),
    )
    .max(6),
});
export const cardProposalSchema = z.object({
  name: z.string().min(1).max(180),
  situation: z.string().min(1).max(8000),
});
export const startSchema = z.object({
  projectId: z.string(),
  datasetId: z.string(),
  textColumn: z.string().min(1),
  idColumn: z.string().min(1),
  task: z.string().min(1).max(3000),
  ownerRules: z.string().max(20000).default(""),
  count: z.number().int().min(1).max(48),
  autoEvaluate: z.boolean().default(false),
  materials: z
    .array(
      z.object({
        datasetId: z.string(),
        kind: z.enum(["prompt", "knowledge"]),
      }),
    )
    .max(8),
  model: z.string().min(1).max(200),
});
export type Source = z.infer<typeof sourceSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type Start = z.infer<typeof startSchema>;
export type Verdict = z.infer<typeof verdictSchema>["rules"][number];
export type Dialogue = { id: string; text: string; topicId?: string };
export type Card = {
  id: string;
  origin: "coverage" | "regression" | "synthetic";
  dialogueId?: string;
  ruleIds: string[];
  name: string;
  situation: string;
  criteria: string[];
  definitionHash: string;
  status: "draft" | "saved";
  scenarioId?: string;
  generated?: boolean;
  confirmedBy?: string;
  confirmedAt?: string;
  runs: {
    id: string;
    agentId: string;
    definitionHash: string;
    at: string;
    judgeModel?: string;
    simulatorModel?: string;
    note?: string;
  }[];
};
export type Analysis = {
  id: string;
  projectId: string;
  datasetId: string;
  name: string;
  task: string;
  model: string;
  ownerRules: string;
  materialRefs: Start["materials"];
  autoEvaluate?: boolean;
  generated?: boolean;
  textColumn: string;
  idColumn: string;
  createdAt: string;
  status: "planning" | "ready" | "judging" | "done" | "failed" | "interrupted";
  message: string;
  total: number;
  selected: number;
  processed: number;
  calls: number;
  sources: Source[];
  dialogues: Dialogue[];
  topics: z.infer<typeof planSchema>["topics"];
  results: { dialogueId: string; topicId: string; rules: Verdict[] }[];
  cards: Card[];
  reviews: {
    dialogueId: string;
    ruleId: string;
    decision: "confirmed" | "disputed" | "unsure";
    note: string;
    userId: string;
    at: string;
  }[];
  experimentSlug?: string;
  runId?: string;
  exportDatasetId?: string;
  exportError?: string;
  error?: string;
  knowledgeGap?: string;
};
