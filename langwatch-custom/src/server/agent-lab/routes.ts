import { z } from "zod";
import { createServiceApp, handlerManagedAuth } from "~/server/api/security";
import { getServerAuthSession } from "~/server/auth";
import { probeProjectPermission } from "~/server/app-layer/permissions/imperative";
import type { Context } from "hono";
import type { Permission } from "~/server/api/rbac";
import { startSchema } from "./schema";
import * as lab from "./service";

const secured = createServiceApp({ basePath: "/api/agent-lab" });
const access = handlerManagedAuth({
  reason: "Native session and project permission checked in each handler",
  permissions: ["project:view"],
  credential: "session",
});
async function authorize(
  c: Context,
  projectId: string,
  permission: Permission,
) {
  const session = await getServerAuthSession({ req: c.req.raw as any });
  if (!session)
    return { response: c.json({ error: "Войдите в LangWatch" }, 401) };
  if (
    !projectId ||
    !(await probeProjectPermission({ session }, projectId, permission))
  )
    return { response: c.json({ error: "Нет доступа к этому проекту" }, 403) };
  if (!(await probeProjectPermission({ session }, projectId, "datasets:view")))
    return {
      response: c.json({ error: "Нужен доступ к данным проекта" }, 403),
    };
  const origin = c.req.header("origin");
  if (origin && new URL(origin).host !== new URL(c.req.url).host)
    return {
      response: c.json({ error: "Запрос другого сайта запрещён" }, 403),
    };
  return { session };
}
function query(handler: (c: Context, projectId: string) => Promise<unknown>) {
  return async (c: Context) => {
    try {
      const projectId = c.req.query("projectId") ?? "";
      const auth = await authorize(c, projectId, "project:view");
      if (auth.response) return auth.response;
      return c.json((await handler(c, projectId)) as any);
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  };
}
function mutate(
  permission: Permission,
  schema: z.ZodTypeAny,
  handler: (body: any, userId: string) => Promise<unknown>,
) {
  return async (c: Context) => {
    try {
      const raw = await c.req.json();
      const auth = await authorize(c, raw.projectId ?? "", permission);
      if (auth.response) return auth.response;
      const body = schema.parse(raw);
      return c.json((await handler(body, auth.session!.user.id)) as any);
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof z.ZodError
              ? "Проверьте поля запроса: " +
                error.issues
                  .map((i) => i.path.join(".") + ": " + i.message)
                  .join("; ")
              : error instanceof Error
                ? error.message
                : String(error),
        },
        400,
      );
    }
  };
}
const ref = z.object({ projectId: z.string(), id: z.string() });
secured.access(access).get(
  "/catalog",
  query((_c, p) => lab.catalog(p)),
);
secured.access(access).get(
  "/analysis/:id",
  query(async (c, p) => lab.view(await lab.get(p, c.req.param("id")!))),
);
secured.access(access).get(
  "/runs/:id/:cardId",
  query((c, p) => lab.runData(p, c.req.param("id")!, c.req.param("cardId")!)),
);
secured.access(access).post(
  "/plan",
  mutate("evaluations:create", startSchema, (b, u) => lab.start(b, u)),
);
secured.access(access).post(
  "/approve",
  mutate(
    "evaluations:create",
    ref.extend({
      rules: z
        .array(
          z.object({
            id: z.string(),
            approved: z.boolean(),
            text: z.string().min(1).max(2000),
            condition: z.string().max(2000),
            acceptable: z.string().max(2000),
          }),
        )
        .max(72),
    }),
    (b) => lab.approve(b.projectId, b.id, b.rules),
  ),
);
secured.access(access).post(
  "/evaluate",
  mutate("evaluations:create", ref, (b) => lab.evaluate(b.projectId, b.id)),
);
secured.access(access).post(
  "/review",
  mutate(
    "evaluations:create",
    ref.extend({
      dialogueId: z.string(),
      ruleId: z.string(),
      decision: z.enum(["confirmed", "disputed", "unsure"]),
      note: z.string().min(1).max(2000),
    }),
    (b, u) =>
      lab.review(
        b.projectId,
        b.id,
        b.dialogueId,
        b.ruleId,
        b.decision,
        b.note,
        u,
      ),
  ),
);
secured.access(access).post(
  "/propose",
  mutate(
    "scenarios:create",
    ref.extend({
      origin: z.enum(["coverage", "regression", "synthetic"]),
      dialogueId: z.string().optional(),
      ruleIds: z.array(z.string()).min(1).max(6),
    }),
    (b, u) =>
      lab.propose(b.projectId, b.id, b.origin, b.dialogueId, b.ruleIds, u),
  ),
);
secured.access(access).post(
  "/card",
  mutate(
    "scenarios:create",
    ref.extend({
      cardId: z.string(),
      name: z.string().min(1).max(180),
      situation: z.string().min(1).max(8000),
      criteria: z.array(z.string().min(1).max(4000)).min(1).max(6),
    }),
    (b) =>
      lab.changeCard(b.projectId, b.id, b.cardId, {
        name: b.name,
        situation: b.situation,
        criteria: b.criteria,
      }),
  ),
);
secured.access(access).post(
  "/accept",
  mutate("scenarios:create", ref.extend({ cardId: z.string() }), (b, u) =>
    lab.accept(b.projectId, b.id, b.cardId, u),
  ),
);
secured.access(access).post(
  "/run",
  mutate(
    "scenarios:create",
    ref.extend({
      cardId: z.string(),
      agentId: z.string(),
      note: z.string().max(200).default(""),
    }),
    (b) => lab.run(b.projectId, b.id, b.cardId, b.agentId, b.note),
  ),
);

// XLSX becomes a normal LangWatch dataset, never a separate import store.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
secured.access(access).post("/xlsx", async (c) => {
  try {
    const projectId = c.req.query("projectId") ?? "";
    const auth = await authorize(c, projectId, "datasets:create");
    if (auth.response) return auth.response;
    if (Number(c.req.header("content-length") ?? 0) > 16_000_000)
      throw new Error("Выберите XLSX до 15 МБ");
    const form = await c.req.formData();
    const file = form.get("file");
    if (!file || typeof file === "string" || file.size > 15_000_000)
      throw new Error("Выберите XLSX до 15 МБ");
    const child = execFile(
      "python3",
      [path.resolve("scripts/agent-lab-xlsx.py")],
      { maxBuffer: 25_000_000 },
    );
    const output = new Promise<string>((resolve, reject) => {
      let data = "";
      let error = "";
      child.stdout?.on("data", (chunk) => (data += chunk));
      child.stderr?.on("data", (chunk) => (error += chunk));
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve(data)
          : reject(new Error(error.slice(-500) || "Таблица не прочитана")),
      );
    });
    child.stdin?.end(Buffer.from(await file.arrayBuffer()));
    const sheets = JSON.parse(await output);
    if (form.get("sheet") === null)
      return c.json({
        sheets: sheets.map((s: any) => ({
          name: s.name,
          rows: s.rows.length,
          columns: Object.keys(s.rows[0] ?? {}),
        })),
      });
    const selected = sheets[Number(form.get("sheet"))];
    if (!selected?.rows.length) throw new Error("Выберите непустой лист");
    const dataset = await lab.api(projectId, "/api/dataset", {
      name:
        String(form.get("name") ?? file.name.replace(/\.xlsx$/i, "")) +
        " · " +
        Date.now().toString().slice(-6),
      columnTypes: Object.keys(selected.rows[0]).map((name) => ({
        name,
        type: "string",
      })),
    });
    for (let i = 0; i < selected.rows.length; i += 250)
      await lab.api(projectId, "/api/dataset/" + dataset.id + "/records", {
        entries: selected.rows.slice(i, i + 250),
      });
    return c.json({ datasetId: dataset.id, rows: selected.rows.length });
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
});
export const app = secured.hono;

secured.access(access).post(
  "/run-all",
  mutate(
    "scenarios:create",
    ref.extend({ agentId: z.string(), note: z.string().max(200).default("") }),
    (b) => lab.runAll(b.projectId, b.id, b.agentId, b.note),
  ),
);

secured.access(access).get(
  "/run-summary/:id",
  query((c, p) => lab.runSummary(p, c.req.param("id")!)),
);
