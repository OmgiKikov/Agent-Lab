import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";

const backendTsFiles = [
  "src/**/*.ts",
  "tests/**/*.ts",
  "scripts/**/*.ts",
  // Playwright e2e specs + fixtures/helpers. They run under node (Playwright
  // CLI shebang) + bun (for the subprocess DB queries) so they belong with
  // the backend config (no React, node globals). Without listing them here
  // they fall through to `eslint.configs.recommended` only — no typescript-
  // eslint, no `no-floating-promises`, no `no-misused-promises`, so a
  // missing `await` on a Playwright locator wouldn't be caught at lint.
  "app/tests-e2e/**/*.ts",
];

const appSrcFiles = ["app/src/**/*.ts", "app/src/**/*.tsx"];

const typeCheckedFor = (files) =>
  tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files,
  }));

export default defineConfig(
  {
    ignores: [
      "**/node_modules/**",
      "dist/**",
      "build/**",
      "app/dist/**",
      "coverage/**",
      ".isolated/**",
      ".claude/**",
      "examples/**",
      "src/**/*.d.ts",
      "**/*.cjs",
      "**/*.config.js",
      "eslint.config.mjs",
      "app/vite.config.ts",
    ],
  },
  eslint.configs.recommended,
  {
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["web/**/*.mjs"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
        Bun: "readonly",
      },
    },
  },
  ...typeCheckedFor(backendTsFiles),
  {
    files: backendTsFiles,
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
            arguments: false,
          },
        },
      ],
    },
  },
  ...typeCheckedFor(appSrcFiles),
  {
    ...react.configs.flat.recommended,
    ...react.configs.flat["jsx-runtime"],
    files: appSrcFiles,
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      parserOptions: {
        project: "./app/tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: { jsx: true },
      },
      globals: globals.browser,
    },
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat["jsx-runtime"].rules,
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksVoidReturn: {
            attributes: false,
            arguments: false,
          },
        },
      ],
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "react/no-unescaped-entities": "off",
      "react/prop-types": "off",
    },
    settings: {
      react: { version: "detect" },
    },
  },
  {
    // Playwright fixture extension requires the `async ({}, use, info) => {}`
    // shape — destructuring an empty object IS the API. Don't lint it away.
    files: ["app/tests-e2e/**/*.ts"],
    rules: {
      "no-empty-pattern": "off",
    },
  },
);
