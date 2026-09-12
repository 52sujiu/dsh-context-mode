# Licensing

This package contains two distinct works under two licenses.

## 1. The DSH adapter — MIT

Copyright (c) 2026 52sujiu

Everything outside `vendor/` is original work and is licensed under the MIT
License in [`LICENSE`](./LICENSE):

- `src/` — the Cordis plugin, MCP bridge, routing guard, CJK adapter
- `scripts/` — build and smoke-test tooling
- `skills/` — the bundled DSH routing skill
- `cordis.patch.yml`, `README.md`

## 2. The vendored engine — Elastic License 2.0

`vendor/context-mode/` is derived from
[context-mode](https://github.com/mksglu/context-mode) by Mert Koseoğlu, and
remains under the **Elastic License 2.0** (ELv2). See
[`vendor/context-mode/LICENSE`](./vendor/context-mode/LICENSE).

The vendored tree has been modified for this package:

- the eighteen platform hook adapters were removed, leaving a single DSH
  adapter (`src/platform/dsh.ts`);
- CJK search support was added on the adapter side.

**ELv2 is not an open-source license.** It permits use, modification, and
redistribution, but prohibits providing the software to third parties as a
hosted or managed service. If you intend to offer this package as a service,
review ELv2 §3 before doing so.

Because ELv2 applies to the vendored engine, the combined package as a whole
may not be relicensed under MIT. The MIT grant above covers only the adapter
code listed in section 1.
