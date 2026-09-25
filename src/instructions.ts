import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { stripFrontmatter } from '@earendil-works/pi-coding-agent';

/*
 * What the model of an Agent Lab chat is told, from one source: the agent-builder skill (skills/agent-builder/SKILL.md)
 * without its frontmatter. `agent-lab chat` hands it to Pi as part of the session's own system prompt, so every model
 * turn carries it — the owner's prompts, and the turns Pi starts by itself for a message of Lab (a finished run, a
 * prepared set, a check), which no `before_agent_start` hook reaches — in this session and in every session /new,
 * /resume, /fork or /reload replaces it with:
 *
 *   agent-lab chat ──► pi --append-system-prompt <instructions> ──► base system prompt of every session ──► every turn
 */

/** The skill beside this module, the same from src/ and from dist/. */
const SKILL = new URL('../skills/agent-builder/SKILL.md', import.meta.url);
let instructions: Promise<string> | undefined;

/**
 * The skill's relative links made absolute. In the system prompt a relative path is read from the owner's project,
 * where `../../examples/…` names nothing; the files it links ship with this package, beside the skill.
 */
function absoluteLinks(text: string, base: URL): string {
  let out = '', at = 0;
  for (let open = text.indexOf('](', at); open >= 0; open = text.indexOf('](', at)) {
    const close = text.indexOf(')', open + 2);
    if (close < 0) break;
    const target = text.slice(open + 2, close);
    const relative = target.length > 0 && !target.includes(':') && !target.startsWith('/') && !target.startsWith('#');
    out += `${text.slice(at, open + 2)}${relative ? fileURLToPath(new URL(target, base)) : target})`;
    at = close + 1;
  }
  return out + text.slice(at);
}

/** The instructions of an Agent Lab chat, read once: the skill's body with its links made absolute. */
export function agentLabInstructions(): Promise<string> {
  return instructions ??= readFile(SKILL, 'utf8').then(text => absoluteLinks(stripFrontmatter(text).trim(), SKILL));
}

/**
 * What `agent-lab chat` gives Pi before the owner's own arguments: no other extensions or skills — the skill is the
 * session's instructions, and listed as a skill as well it would only invite the model to read the same text twice —,
 * the instructions as part of every session's system prompt, and the extension at `extension`. An appended prompt
 * given this way stands in for Pi's own APPEND_SYSTEM.md, as the chat stands apart from the owner's other extensions.
 */
export async function chatArguments(extension: string): Promise<string[]> {
  return ['--no-extensions', '--no-skills', '--exclude-tools', 'bash,edit,write', '--append-system-prompt', await agentLabInstructions(), '-e', extension];
}
