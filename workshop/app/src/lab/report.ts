import { STATUS_TEXT, personaName } from "./look";
import { KIND_LABEL, normRule, type Criterion } from "./criteria";
import type { Item, Persona } from "./types";

/** One conversation as plain text, for a ticket or a chat: the dialogue, the verdict and what failed. */
export function transcript(item: Item, personas: Persona[]): string {
  const who = personaName(personas, item.persona);
  const head = `${item.name} · ${who}${item.attempt && item.attempt > 1 ? ` · повтор ${item.attempt}` : ""}`;
  const dialogue = item.conversation.map(m => `${m.role === "customer" ? "Клиент" : "Агент"}: ${m.text}`).join("\n\n");
  const failed = item.rules.filter(r => r.status === "FAIL")
    .map(r => `- ${r.rule}\n  ${r.reason}${r.agentQuote ? `\n  «${r.agentQuote}»` : ""}`).join("\n");
  return [head, "", dialogue, "", `Вердикт судьи: ${STATUS_TEXT[item.status]}`, failed].filter((x, i, all) => x || all[i - 1]).join("\n").trim();
}

/** A criterion as text for a ticket or for the person who edits the agent's prompt. */
export function criterionReport(c: Criterion, personas: Persona[]): string {
  const total = c.passed + c.failed;
  const lines = [`# ${c.title}`, "", `Нарушено в ${c.failed} из ${total} диалогов.`, ""];
  if (c.rule !== c.title) lines.push(`Критерий: ${c.rule}`, "");
  if (c.quote) lines.push(`В источнике${c.kind ? ` (${KIND_LABEL[c.kind] ?? c.kind})` : ""}: «${c.quote}»`, "");
  lines.push("## Примеры", "");
  for (const d of c.failing.slice(0, 5)) {
    const rule = d.rules.find(r => normRule(r.rule) === c.key && r.status === "FAIL");
    lines.push(`- ${d.opening} (${d.origin === "log" ? "лог" : `симулятор, ${personaName(personas, d.persona)}`})`);
    if (rule?.agentQuote) lines.push(`  Агент: «${rule.agentQuote}»`);
    if (rule?.reason) lines.push(`  Почему нарушение: ${rule.reason}`);
  }
  return lines.join("\n");
}
