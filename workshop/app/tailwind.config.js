import animate from "tailwindcss-animate";

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Barlow", "system-ui", "sans-serif"],
        mono: ["Space Mono", "monospace"],
      },
      fontSize: {
        label: "10px",
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
