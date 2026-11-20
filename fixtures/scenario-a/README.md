# Scenario A — dependency migration (TS monorepo)

Intent: "replace moment with dayjs".

- `src/date/format-date.ts` + `package.json` carry the `moment` touchpoints.
- `src/cycle/a.ts` ↔ `b.ts` form an import cycle on purpose (exercises cycle detection).
- Acceptance: those touchpoints, callers + cycle in the impact graph, native test
  selection, and a moment→dayjs diff verified inside the sandbox — see
  `PROJECT_SPEC.md` §14 and `tests/acceptance.test.ts`.
