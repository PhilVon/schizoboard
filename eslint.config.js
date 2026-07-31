/**
 * The two architecture rules, mechanically.
 *
 * docs/ARCHITECTURE.md section 1 states them and then says of the first: "it's
 * enforceable with a lint rule, so enforce it." Both are the kind of rule that
 * holds perfectly until the afternoon someone needs one item position in a
 * hurry, and by then unpicking it is a refactor rather than a diff.
 *
 * Deliberately *not* type-aware. These are import-graph rules, so the fast
 * syntactic parser is enough and `npm run lint` stays a couple of seconds.
 */

import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Rule 1 — nothing outside crdt/ touches Yjs directly. */
const YJS_ONLY_IN_CRDT = {
  name: "yjs",
  message:
    "Only crdt/ may import yjs. Every document mutation goes through crdt/ops/, " +
    "which is what makes undo scoping, echo suppression and write batching possible " +
    "(ARCHITECTURE section 1, rule 1).",
};

/** The narrower half of rule 1 — only ops open transactions. */
const MUTATE_ONLY_IN_OPS = {
  name: "@/crdt/doc",
  importNames: ["mutate"],
  message:
    "mutate() belongs to crdt/ops/. A transaction opened anywhere else has an " +
    "origin nobody registered, so undo silently ignores it (DATA-MODEL section 11).",
};

/**
 * `lib/` stays dependency-free.
 *
 * Not one of the two rules, but the thing that keeps rule 2 checkable. The
 * rule below is an import-graph rule one hop deep, so the day `render/` imports
 * a `lib/` module that imports `crdt/`, `render/` depends on the document and
 * lint says nothing. `lib/seed.ts` states the contract — "dependency-free
 * primitives, importable by anyone" — and this is what holds it.
 */
const LIB_IMPORTS_NOTHING = {
  group: ["@/crdt", "@/crdt/*", "@/render/*", "@/state/*", "@/app/*", "@/platform/*"],
  message:
    "lib/ is dependency-free primitives, importable by anyone — including render/, " +
    "which may not reach crdt/ even through one of these. Policy that needs the rest " +
    "of the application belongs next to the thing that uses it.",
};

/** Rule 2 — sim/ and render/ read the scene mirror, never the document. */
const NO_CRDT_FROM_RENDER_OR_SIM = {
  group: ["@/crdt", "@/crdt/*", "**/crdt/*"],
  message:
    "sim/ and render/ never import crdt/. They read the plain scene mirror in " +
    "state/scene.ts; crdt/binding.ts is the only translator. Durable state flows " +
    "one way (ARCHITECTURE section 1, rule 2).",
};

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "src-tauri/**", "public/**"] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ["**/*.ts"],
    rules: {
      // The codebase leans on leading-underscore parameters for interface
      // conformance — a mock that must accept an argument it ignores.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-restricted-imports": [
        "error",
        { paths: [YJS_ONLY_IN_CRDT, MUTATE_ONLY_IN_OPS] },
      ],
    },
  },

  {
    files: ["src/crdt/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { paths: [MUTATE_ONLY_IN_OPS] }],
    },
  },

  {
    files: ["src/crdt/ops/**/*.ts", "src/crdt/doc.ts"],
    rules: { "no-restricted-imports": "off" },
  },

  {
    files: ["src/render/**/*.ts", "src/sim/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [YJS_ONLY_IN_CRDT], patterns: [NO_CRDT_FROM_RENDER_OR_SIM] },
      ],
    },
  },

  {
    files: ["src/lib/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [YJS_ONLY_IN_CRDT], patterns: [LIB_IMPORTS_NOTHING] },
      ],
    },
  },

  {
    // The spike is scaffolding for one measurement, not product code.
    files: ["src/spike/**/*.ts", "scripts/**/*.mjs"],
    rules: { "no-restricted-imports": "off" },
  },

  {
    // Build scripts run in Node, not the webview.
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        // Node 22's own, so the CDP rig in `spike-video.mjs` needs no `ws`.
        WebSocket: "readonly",
      },
    },
  },
);
