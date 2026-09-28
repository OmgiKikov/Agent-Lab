import { C } from "../utils/colors";

export function Button({ children, onClick, className = "" }: {
  children: React.ReactNode; onClick?: () => void; className?: string;
}) {
  return (
    <button
      className={`text-[11px] font-mono font-medium px-2.5 py-1.5 rounded transition-colors ${className}`}
      style={{ color: C.fg3, background: "rgba(255,255,255,0.10)" }}
      onMouseEnter={e => { e.currentTarget.style.background = "rgba(255,255,255,0.20)"; }}
      onMouseLeave={e => { e.currentTarget.style.background = "rgba(255,255,255,0.10)"; }}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
