import animate from "tailwindcss-animate";

/** Agent Lab's tokens (docs/DESIGN.md): rgb channels live in index.css, so `bg-lab-ok/10` style alpha works. */
const LAB_COLORS = [
  // surfaces, darkest to lightest: lightness is elevation; the canvas is Raindrop's black
  "canvas", "panel", "card", "raised", "active",
  // text: Raindrop's cool steel ramp, five steps
  "ink", "text", "soft", "mute", "faint",
  // meaning: one accent (focus, selection, links, what is live); status colours carry meaning and nothing else
  "accent", "accent-solid", "ok", "bad", "warn",
  // the judge's quote in a conversation (a marker highlight), the customer's bubble
  "mark", "user",
];

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Commissioner: Raindrop's Barlow in spirit (a compact grotesk), with Cyrillic. Geist Mono: Raindrop's labels and ids.
        sans: ["Commissioner Variable", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ["Geist Mono Variable", "ui-monospace", "SF Mono", "Menlo", "monospace"],
        // Raindrop's display face; it has no Cyrillic, so Russian falls through to Commissioner.
        display: ["AlphaLyrae", "Commissioner Variable", "system-ui", "sans-serif"],
      },
      fontSize: {
        label: "10px",
        default: "12px",
        message: "14px",
        header: "21px",
        // Agent Lab's type scale: named by role, not by size
        micro: ["10px", { lineHeight: "14px", letterSpacing: "0.06em" }],
        caption: ["12px", { lineHeight: "16px" }],
        body: ["13px", { lineHeight: "20px" }],
        reading: ["14px", { lineHeight: "22px" }],
        lead: ["16px", { lineHeight: "24px", letterSpacing: "-0.005em" }],
        title: ["20px", { lineHeight: "26px", letterSpacing: "-0.012em" }],
        display: ["30px", { lineHeight: "36px", letterSpacing: "-0.025em" }],
        metric: ["30px", { lineHeight: "34px", letterSpacing: "-0.02em" }],
        hero: ["56px", { lineHeight: "56px", letterSpacing: "-0.04em" }],
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
        pop: "0 0 0 1px rgb(255 255 255 / 0.08), 0 2px 6px rgb(0 0 0 / 0.40), 0 16px 40px -8px rgb(0 0 0 / 0.70)",
        card: "inset 0 1px 0 rgb(255 255 255 / 0.03)",
      },
      transitionTimingFunction: {
        out: "cubic-bezier(.23, 1, .32, 1)",
        "in-out": "cubic-bezier(.77, 0, .175, 1)",
      },
    },
  },
  plugins: [animate],
};
