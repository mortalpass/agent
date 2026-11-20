# Scenario B — feature change (TS + Python monorepo)

Intent: "给 UserService 增加租户隔离".

- TS side: `ts/user-service.ts` (`UserService.findById`, callers in `ts/app.ts` and
  the test), analyzed exactly (confidence 1) via ts-morph.
- Python side: `py/gw.py` (`call_gateway`) imported by `py/user_client.py`,
  analyzed text-heuristically (confidence 0.7 definitions / lower references) —
  the limitation is disclosed, never hidden.
- Acceptance: cross-language touchpoint/caller map, coverage, plan, sandbox
  diff, and a risk report carrying `limited-confidence` plus an explicit
  Python-AST disclosure; see `PROJECT_SPEC.md` §14 and `tests/acceptance.test.ts`.
