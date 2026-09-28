// Single source of truth for skill markdown shipped with the UI.
//
// The SKILL.md files under `skills/` are installed by `raindrop setup`.
// For users on other AI coding tools (Cursor, Codex, ...) we expose the same
// content via the "Copy skill prompt" button on the Local Agent CTA. Vite's `?raw` import
// inlines the file contents at build time so there's no daemon round-trip
// and no duplicated copy of the skill text in the repo.
import setupAgentReplaySkillRaw from "../../../skills/setup-agent-replay/SKILL.md?raw";

/** Raw SKILL.md content (frontmatter included) keyed by skill name. */
export const SKILL_RAW: Record<string, string> = {
  "setup-agent-replay": setupAgentReplaySkillRaw,
};

/** Strip the leading `---\n...\n---\n` YAML frontmatter, if present. */
function stripFrontmatter(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n+/, "");
}

/**
 * Build a copy-paste-ready prompt for the user's AI coding tool: a one-line
 * framing for context, followed by the skill body without YAML frontmatter
 * (which is meaningless outside Claude Code).
 */
export function buildSkillPrompt(name: keyof typeof SKILL_RAW): string {
  const raw = SKILL_RAW[name];
  if (!raw) return "";
  const body = stripFrontmatter(raw);
  const header =
    "Follow the instructions below to wire a Raindrop Workshop \"Local Agent\" replay endpoint into this repo. " +
    "You're running in the user's agent repo, not Workshop's. Work step by step.";
  return `${header}\n\n---\n\n${body}`;
}
