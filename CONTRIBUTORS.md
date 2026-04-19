# Contributors

## Development Workflow

Bun is the package manager. The published CLI still runs on Node (`#!/usr/bin/env node`), so end users installing the binary do not need Bun.

```bash
bun install
bun run check
bun run build
node dist/index.js scan --source claude --db /tmp/agent-vitals.db
```

Useful scripts:

- `bun run build` — compile TypeScript to `dist/`
- `bun run typecheck` — `tsc --noEmit`
- `bun run lint` — Biome lint + import hygiene
- `bun run format:check` / `bun run format` — Prettier
- `bun run check` — typecheck, lint, and format check together

To install the built CLI globally while developing:

```bash
bun install
bun run build
npm install -g .
```

Do not commit `package-lock.json`; `bun.lock` is the canonical lockfile.

## Inspiration

- **[@stellaraccident](https://github.com/stellaraccident)** — The original analysis in [anthropics/claude-code#42796](https://github.com/anthropics/claude-code/issues/42796) that proved reduced thinking depth caused measurable quality collapse across 234,760 tool calls. Every metric, benchmark, and threshold in this tool traces back to that work. The Read:Edit ratio framework, blind edit detection, laziness signal taxonomy, sentiment analysis approach, and the core insight that signature length correlates 0.97 with actual thinking depth — all from that issue.
