import animate from "tailwindcss-animate";

const rgb = (name) => `rgb(var(--${name}) / <alpha-value>)`;

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      // Onest for everything a person reads; JetBrains Mono only for the paths, IDs and code a developer reads. Both carry Cyrillic and ship inside the build.
      fontFamily: {
        sans: ["Onest Variable", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono Variable", "ui-monospace", "monospace"],
      },
      // The named scale (docs/DESIGN.md): reading text is 15 and 17; nothing with a meaning under 13. The big sizes
      // are for the one number a screen exists to say.
      fontSize: {
        label: ["11px", { lineHeight: "16px" }],
        meta: ["12px", { lineHeight: "16px" }],
        small: ["13px", { lineHeight: "18px" }],
        body: ["14px", { lineHeight: "20px" }],
        read: ["15px", { lineHeight: "24px" }],
        lead: ["17px", { lineHeight: "26px", letterSpacing: "-0.005em" }],
        count: ["20px", { lineHeight: "24px", letterSpacing: "-0.01em" }],
        title: ["22px", { lineHeight: "28px", letterSpacing: "-0.015em" }],
        page: ["32px", { lineHeight: "38px", letterSpacing: "-0.022em" }],
        display: ["44px", { lineHeight: "48px", letterSpacing: "-0.028em" }],
        hero: ["68px", { lineHeight: "68px", letterSpacing: "-0.035em" }],
        // The Workshop's message text (components/ChatFlow, ConvoDetail, pages/SearchPage).
        message: "14px",
      },
      letterSpacing: { caps: "0.06em" },
      borderRadius: { control: "10px", block: "14px", sheet: "20px" },
      boxShadow: {
        pop: "0 18px 48px -12px rgb(0 0 0 / 0.22), 0 0 0 1px rgb(0 0 0 / 0.06)",
        card: "0 1px 2px rgb(0 0 0 / 0.04), 0 10px 30px -14px rgb(0 0 0 / 0.14)",
      },
      transitionTimingFunction: { out: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      colors: {
        canvas: rgb("canvas"),
        side: rgb("side"),
        list: rgb("list"),
        inset: rgb("inset"),
        hover: rgb("hover"),
        raised: rgb("raised"),
        selected: rgb("selected"),
        fg: { DEFAULT: rgb("fg"), 2: rgb("fg-2"), 3: rgb("fg-3"), 4: rgb("fg-4") },
        bad: rgb("bad"),
        ok: rgb("ok"),
        warn: rgb("warn"),
        run: rgb("run"),
        primary: rgb("primary"),
        mark: { DEFAULT: rgb("mark"), strong: rgb("mark-strong") },
        customer: { DEFAULT: rgb("customer"), fg: rgb("customer-fg") },
        line: { DEFAULT: "var(--line)", strong: "var(--line-strong)" },
        well: "var(--well)",
        paper: { DEFAULT: rgb("paper"), well: rgb("paper-well") },
        ink: { DEFAULT: rgb("ink"), 2: rgb("ink-2"), 3: rgb("ink-3"), line: rgb("ink-line"), bad: rgb("ink-bad") },
      },
    },
  },
  plugins: [animate],
};
