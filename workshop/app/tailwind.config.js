import animate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        // Commissioner is the Cyrillic grotesk closest to Raindrop's Barlow; both ship inside the build.
        sans: ["Commissioner Variable", "system-ui", "sans-serif"],
        mono: ["Geist Mono Variable", "ui-monospace", "monospace"],
      },
      // The named scale (docs/superpowers/specs/2026-09-30-agent-lab-unified-product-design.md, section 6);
      // default / message / header stay for the Workshop screens until they move to it.
      fontSize: {
        // Three sizes and nothing between: 11 for captions and labels, 13 for text, 20 for titles and big numbers.
        micro: ["11px", "16px"],
        label: ["11px", "16px"],
        meta: ["11px", "16px"],
        small: ["13px", "19px"],
        body: ["13px", "19px"],
        read: ["13px", "20px"],
        title: ["20px", "26px"],
        page: ["20px", "26px"],
        count: ["20px", "26px"],
        stat: ["16px", "22px"],
        heading: ["13px", "19px"],
        default: "12px",
        message: "14px",
        header: "21px",
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
        lab: Object.fromEntries(
          ["bg", "surface", "raised", "hover", "active", "ink", "text", "soft", "mute", "dim", "faint", "user", "accent", "ok", "bad", "warn", "mark"]
            .map(name => [name, `rgb(var(--lab-${name}) / <alpha-value>)`]),
        ),
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
      },
    },
  },
  plugins: [animate],
};
