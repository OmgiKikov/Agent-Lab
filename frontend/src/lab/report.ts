import { cellOf, failureReasons, scenariosOfRun, typesOfRun, unitOf } from "./logic";
import { STATUS_TEXT, personaName } from "./look";
import type { Cell } from "./logic";
import { KIND_LABEL, normRule, type Criterion } from "./criteria";
import type { Item, LabRun, Persona } from "./types";
import { plural } from "./format";

const MARK: Record<Cell["state"], (c: Cell) => string> = {
  PASS: () => "✓",
  FAIL: () => "✗",
  MIXED: (c) => `${c.passed}/${c.done}`,
  UNMEASURED: () => "?",
  RUNNING: () => "…",
  NONE: () => "–",
};

/** One conversation as plain text, for a ticket or a chat: the dialogue, the verdict and what failed. */
export function transcript(item: Item, personas: Persona[]): string {
  const who = personaName(personas, item.persona);
  const head = `${item.name} · ${who}${item.attempt && item.attempt > 1 ? ` · повтор ${item.attempt}` : ""}`;
  const dialogue = item.conversation
    .map((m) => `${m.role === "customer" ? "Клиент" : "Агент"}: ${m.text}`)
    .join("\n\n");
  const failed = item.rules
    .filter((r) => r.status === "FAIL")
    .map((r) => `- ${r.rule}\n  ${r.reason}${r.agentQuote ? `\n  «${r.agentQuote}»` : ""}`)
    .join("\n");
  return [head, "", dialogue, "", `Вердикт судьи: ${STATUS_TEXT[item.status]}`, failed]
    .filter((x, i, all) => x || all[i - 1])
    .join("\n")
    .trim();
}

/** The accuracy of a run as Markdown: the number, where it breaks, what fails most, how far to trust it. */
export function report(run: LabRun, personas: Persona[], previous: LabRun | null): string {
  const m = run.metric!;
  const items = run.items ?? [];
  const types = typesOfRun(run, personas);
  const unit = unitOf(items);
  const delta = previous?.metric?.accuracy != null && m.accuracy != null ? m.accuracy - previous.metric.accuracy : null;
  const lines = [
    `# Точность агента: ${run.targetName}, ${run.version}`,
    "",
    `Прогон от ${new Date(run.startedAt).toLocaleString("ru-RU")}.`,
    "",
    `**${m.accuracy ?? "—"}%**: агент выполнил все критерии в ${m.passed} из ${m.measured} ${unit === "разговоров" ? plural(m.measured, "разговора", "разговоров", "разговоров") : plural(m.measured, "сценария", "сценариев", "сценариев")}. ` +
      `Провалено ${m.failed}, не измерено ${m.unmeasured}.` +
      (delta !== null
        ? ` К ${previous!.version}: ${delta > 0 ? "+" : delta < 0 ? "−" : ""}${Math.abs(delta)} п. п.`
        : ""),
    "",
  ];
  if (items.length) {
    lines.push(
      "## Сценарии и типы клиентов",
      "",
      `| Сценарий | ${types.map((p) => p.name).join(" | ")} |`,
      `| --- |${types.map(() => " :---: |").join("")}`,
    );
    for (const s of scenariosOfRun(items))
      lines.push(
        `| ${s.name} | ${types
          .map((p) => {
            const c = cellOf(items, s.id, p.id);
            return MARK[c.state](c);
          })
          .join(" | ")} |`,
      );
    lines.push("", "✓ выполнены критерии, ✗ провал, 1/2 результат меняется в повторах, ? не измерено.", "");
  }
  const reasons = failureReasons(items).slice(0, 5);
  if (reasons.length)
    lines.push(
      "## Чаще всего проваливаются",
      "",
      ...reasons.map(([rule, n], i) => `${i + 1}. ${rule}: ${n} ${plural(n, "раз", "раза", "раз")}`),
      "",
    );
  lines.push("## Можно ли доверять оценке", "");
  lines.push(
    `- Второй судья: ${m.secondJudge ? `согласен в ${m.secondJudge.agree} из ${m.secondJudge.checked}` : "не запускался"}.`,
  );
  lines.push(
    `- Повторы: ${m.repeats ? `одинаковый итог у ${m.repeats.stable} из ${m.repeats.scenarios}` : "не запускались"}.`,
  );
  lines.push(
    `- Проверка человеком: ${m.human ? `проверено ${m.human.reviewed}, судья прав в ${m.human.agree}` : "не проводилась"}.`,
  );
  lines.push("- Каждый вердикт подтверждён цитатой из ответа агента.", "");
  return lines.join("\n");
}

/** Save text as a file through the browser. */
export function download(name: string, text: string, type = "text/markdown") {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A criterion as text for a ticket or for the person who edits the agent's prompt. */
export function criterionReport(c: Criterion, personas: Persona[]): string {
  const total = c.passed + c.failed;
  const lines = [`# ${c.title}`, "", `Нарушено в ${c.failed} из ${total} диалогов.`, ""];
  if (c.rule !== c.title) lines.push(`Критерий: ${c.rule}`, "");
  if (c.quote) lines.push(`В источнике${c.kind ? ` (${KIND_LABEL[c.kind] ?? c.kind})` : ""}: «${c.quote}»`, "");
  lines.push("## Примеры", "");
  for (const d of c.failing.slice(0, 5)) {
    const rule = d.rules.find((r) => normRule(r.rule) === c.key && r.status === "FAIL");
    lines.push(`- ${d.opening} (${d.origin === "log" ? "лог" : `симулятор, ${personaName(personas, d.persona)}`})`);
    if (rule?.agentQuote) lines.push(`  Агент: «${rule.agentQuote}»`);
    if (rule?.reason) lines.push(`  Почему нарушение: ${rule.reason}`);
  }
  return lines.join("\n");
}
