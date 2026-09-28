import { Check, Copy } from "lucide-react";
import { useState } from "react";
import anthropicIcon from "../assets/agent-icons/anthropic.svg";
import clineIcon from "../assets/agent-icons/cline.svg";
import cursorIcon from "../assets/agent-icons/cursor.svg";
import geminiIcon from "../assets/agent-icons/gemini.svg";
import windsurfIcon from "../assets/agent-icons/windsurf.svg";
import codexLogo from "../assets/codex-logo.svg";
import { C } from "../utils/colors";
import { DropPixelGrid } from "./DropPixelGrid";

/**
 * Shown on the runs page when the daemon hasn't received any spans yet.
 *
 * Anyone seeing this screen has, by definition, already installed
 * raindrop — the daemon is what's serving this UI to their browser.
 * So we don't show "install raindrop" CTAs (they'd be stale and
 * confusing). We show "you're set up; now run your agent" + a
 * checklist for the case where the project itself isn't wired up.
 *
 * The "another project" panel covers the day-2 case: user already
 * has raindrop on their machine and wants to debug a NEW project.
 *
 * The "other AI tools" copy-prompt panel covers users who use Codex,
 * or some agent that doesn't read MCP from Cursor / Claude
 * Code's config dirs. They can paste the prompt and have their
 * agent walk them through it.
 *
 * Port is hardcoded to 5899 to match the published install URL and
 * the marketing copy in README.md. We deliberately don't read it from
 * `window.location` because that prints the wrong port in dev mode
 * (Vite serves the UI on :5900, daemon listens on :5899).
 */

const SETUP_ANOTHER_SLASH = `/instrument-agent`;

const AGENTS = [
  { name: "Cursor", localHref: "cursor://", icon: cursorIcon },
  { name: "Claude Code", icon: anthropicIcon },
  { name: "Codex", icon: codexLogo, invertIcon: true },
  { name: "Windsurf", localHref: "windsurf://", icon: windsurfIcon },
  { name: "Gemini CLI", icon: geminiIcon },
  { name: "Cline", localHref: "vscode://extension/saoudrizwan.claude-dev", icon: clineIcon },
] as const;

interface EmptyStateProps {
  firstTime?: boolean;
  onFirstTimeDone?: () => void;
  onSeeDemoTraces?: () => void | Promise<void>;
}

export function EmptyState({ onSeeDemoTraces }: EmptyStateProps) {
  const [demoLoading, setDemoLoading] = useState(false);

  async function handleSeeDemoTraces() {
    if (!onSeeDemoTraces || demoLoading) return;
    setDemoLoading(true);
    try {
      await onSeeDemoTraces();
    } finally {
      setDemoLoading(false);
    }
  }

  return (
    <div className="relative h-full overflow-auto px-6 py-10 sb">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background: "linear-gradient(180deg, rgba(255,255,255,0.018), transparent 42%)",
        }}
      />
      <div className="relative mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center text-center">
        <div className="mb-3">
          <DropPixelGrid fillRgb="142,157,166" />
        </div>

        <h1
          className="text-center"
          style={{
            fontFamily: '"AlphaLyrae", sans-serif',
            fontSize: "38px",
            fontWeight: 500,
            lineHeight: 1.12,
            letterSpacing: "-0.02em",
            color: C.fg2,
          }}
        >
          Waiting for your agent...
        </h1>

        <p className="mb-6 mt-1 max-w-2xl text-center text-[15px] font-light leading-7" style={{ color: C.fg3 }}>
          Now just instrument your agent using our skill. Next run, you'll see traces here.
        </p>
        <CommandPill value={SETUP_ANOTHER_SLASH} large />
        {onSeeDemoTraces && (
          <button
            type="button"
            onClick={handleSeeDemoTraces}
            disabled={demoLoading}
            className="mt-3 text-[14px] underline underline-offset-4 decoration-white/20 transition-all duration-150 hover:-translate-y-0.5 hover:decoration-white/70 hover:text-white/85 disabled:cursor-wait disabled:opacity-60 disabled:hover:translate-y-0"
            style={{
              color: C.fg2,
              background: "transparent",
            }}
          >
            {demoLoading ? "Loading demo traces..." : "See demo traces"}
          </button>
        )}

        <WorksWith />

        <p className="mt-8 max-w-xl text-center text-sm leading-6" style={{ color: C.fg1 }}>
          Traces will appear here as soon as your instrumented agent runs.
        </p>
      </div>
    </div>
  );
}

type Agent = (typeof AGENTS)[number];

function CommandPill({ value, large = false }: { value: string; large?: boolean }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      onClick={copy}
      className={`group mt-4 inline-flex items-center gap-0 overflow-hidden rounded-full font-mono transition-all duration-200 hover:scale-[1.02] hover:gap-1.5 hover:bg-white/15 ${large ? "px-5 py-2 text-lg" : "px-3 py-1 text-[13px]"}`}
      style={{
        color: copied ? C.green : C.fg5,
        background: "rgba(255,255,255,0.075)",
        border: "1px solid rgba(255,255,255,0.13)",
        boxShadow: large ? "0 12px 40px rgba(0,0,0,0.28)" : "none",
      }}
      title={copied ? "Copied" : "Click to copy"}
    >
      <span>{value}</span>
      <span
        className={`grid h-5 place-items-center transition-all duration-200 ${
          copied ? "ml-1.5 w-4 opacity-100" : "w-0 opacity-0 group-hover:ml-1.5 group-hover:w-4 group-hover:opacity-100"
        }`}
        style={{
          color: copied ? C.green : C.fg2,
        }}
      >
        {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </span>
    </button>
  );
}

function WorksWith() {
  return (
    <div className="mt-9 flex max-w-xl flex-col items-center gap-2.5">
      <div className="text-[10px] uppercase tracking-[0.22em]" style={{ color: C.fg0 }}>
        Works with
      </div>
      <div className="flex flex-wrap items-center justify-center gap-2.5">
        {AGENTS.map((agent) => (
          <AgentName key={agent.name} agent={agent} />
        ))}
      </div>
    </div>
  );
}

function AgentName({ agent }: { agent: Agent }) {
  const content = (
    <>
      <AgentGlyph agent={agent} />
      <span className="sr-only">{agent.name}</span>
    </>
  );

  if ("localHref" in agent) {
    return (
      <a
        href={agent.localHref}
        className="inline-flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-white/10"
        style={{ color: C.fg1, background: "rgba(255,255,255,0.035)", border: "1px solid rgba(255,255,255,0.06)" }}
        title={`Open ${agent.name}`}
      >
        {content}
      </a>
    );
  }

  return (
    <span
      className="inline-flex h-8 w-8 items-center justify-center rounded-full"
      style={{ color: C.fg1, background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)" }}
      title={agent.name}
    >
      {content}
    </span>
  );
}

function AgentGlyph({ agent }: { agent: Agent }) {
  return (
    <span
      className="flex h-5 w-5 items-center justify-center rounded-full"
      style={{ background: "invertIcon" in agent && agent.invertIcon ? "rgba(255,255,255,0.86)" : "transparent" }}
    >
      <img src={agent.icon} alt="" className="h-3.5 w-3.5 object-contain opacity-75" />
    </span>
  );
}
