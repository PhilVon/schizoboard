# `src/` — module layout

The authoritative version of this layout is
[`docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) section 2. Directories are
created here as the tasks that fill them land; the two rules below apply from
the first line of code.

> **1 · Every document mutation goes through `crdt/ops/`.**
> Nothing anywhere else touches Yjs directly. Every op wraps a transaction with
> an explicit origin — that is what makes undo scoping, echo suppression and
> write batching possible at all.

> **2 · `sim/` and `render/` never import `crdt/`.**
> They read the plain in-memory scene mirror in `state/scene.ts`.
> `crdt/binding.ts` is the only file in the codebase that subscribes to Yjs
> events. Durable state flows exactly one way:
>
> ```
> interaction → crdt/ops → Y.Doc → observer → binding → Scene → render
> ```

The scoped exception is **ephemeral** state — a live drag pose, a wet ink
stroke — which writes straight to the Scene and to awareness and reconciles
when the document write lands.

| Directory | Owns |
|---|---|
| `app/` | bootstrap, window chrome, menus, provider wiring |
| `crdt/` | schema, `Y.Doc`, `ops/`, `binding.ts`, undo, persistence, `sync/` |
| `state/` | scene mirror, dirty sets, camera, selection, `tools/` |
| `sim/` | verlet, catenary, ropes, torsion, collide, constants |
| `render/` | the single rAF loop, world transform, culling, items, ink, ropes, pins, presence, cork |
| `platform/` | every `invoke()`, clipboard, files — mockable for browser dev |
| `styles/` | global chrome only; board content is styled by `render/` |
| `ui/` | toolbars, panels, dialogs — **not** the board |

Imports use the `@/` alias for `src/` (`import { host } from "@/platform/env"`).
