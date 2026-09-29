import animate from "tailwindcss-animate";

/** Agent Lab's tokens (docs/DESIGN.md): rgb channels live in index.css, so `bg-lab-ok/10` style alpha works. */
const LAB_COLORS = [
  // surfaces, darkest to lightest: lightness is elevation
  "canvas", "panel", "card", "raised", "active",
  // text, four steps only
  "ink", "text", "mute", "faint",
  // one accent (focus, selection, links, the current version); status colours carry meaning and nothing else
  "accent", "accent-solid", "ok", "bad", "warn",
  // the customer's bubble in a conversation
  "user",
  // aliases of the earlier palette, kept so older screens still read: surface = panel, soft = text, dim = mute, bg = canvas
  "bg", "surface", "soft", "dim",
];

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter Variable", "Inter", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["Geist Mono Variable", "ui-monospace", "SF Mono", "Menlo", "monospace"],
      },
      fontSize: {
        label: "10px",
        default: "12px",
        message: "14px",
        header: "21px",
        // Agent Lab's type scale: named by role, not by size
        micro: ["11px", { lineHeight: "14px" }],
        caption: ["12px", { lineHeight: "16px" }],
        body: ["13px", { lineHeight: "20px" }],
        reading: ["14px", { lineHeight: "22px" }],
        lead: ["16px", { lineHeight: "24px", letterSpacing: "-0.006em" }],
        title: ["20px", { lineHeight: "28px", letterSpacing: "-0.014em" }],
        display: ["28px", { lineHeight: "34px", letterSpacing: "-0.022em" }],
        metric: ["40px", { lineHeight: "44px", letterSpacing: "-0.03em" }],
        hero: ["72px", { lineHeight: "72px", letterSpacing: "-0.045em" }],
      },
      borderColor: {
        border: "var(--border)",
      },
      backgroundColor: {
        background: "var(--background)",
        muted: "var(--muted)",
      },
      textColor: {
        foreground: "var(--foreground)",
        "muted-foreground": "var(--muted-foreground)",
        primary: "var(--primary)",
      },
      colors: {
        lab: {
          ...Object.fromEntries(LAB_COLORS.map(name => [name, `rgb(var(--lab-${name}) / <alpha-value>)`])),
          // hairlines: white at a fixed alpha, so they read on any surface
          line: "rgb(255 255 255 / 0.06)",
          edge: "rgb(255 255 255 / 0.10)",
          strong: "rgb(255 255 255 / 0.16)",
        },
      },
      boxShadow: {
        pop: "0 0 0 1px rgb(255 255 255 / 0.08), 0 2px 6px rgb(0 0 0 / 0.30), 0 12px 32px -6px rgb(0 0 0 / 0.55)",
        card: "inset 0 1px 0 rgb(255 255 255 / 0.035)",
      },
      transitionTimingFunction: {
        out: "cubic-bezier(.23, 1, .32, 1)",
        "in-out": "cubic-bezier(.77, 0, .175, 1)",
      },
    },
  },
  plugins: [animate],
};
