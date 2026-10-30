# FilsPay — instructions for AI coding agents

Team S^2. This file replaces the earlier version, whose rules were wrong in ways that caused bugs
(each correction below links to the finding in BUGS.md). **Do not trust a comment, ADR, old test or
AI answer that says something is "safe", "unique", "intended" or "already handled" until you have
checked the code or reproduced it.** In this repo several such claims were false.

## Build & test
- API: `cd apps/api && npx tsx --test <file>`; whole API: `npm test`. Go: `cd apps/settlement && go test ./...`.
- Tests need Postgres (`DATABASE_URL`). Run TS and Go tests one after the other (they share the DB).
- A failing test is not automatically a code bug: first check whether the test itself asserts the wrong
  number (Bugs 1, 40, 42, 36, 44 were encoded in tests).

## Money
- Amounts are integer **fils**: 1 BD = **1000** fils (3 decimals), not cents (Bug 1).
- Parse text amounts with `parseBhdToFils` (rejects more than 3 decimals). Never `parseFloat * 100`.
- Rates are basis points; use `applyRateFils` (half-to-even). No `float32`/`float64` on money (Bugs 13, 38, 39).
- Counters that hold money are `BIGINT` / `int64`, never `INTEGER` / `int32` (Bug 37).

## Settlement and time
- Business days are **Asia/Bahrain** (UTC+3, no DST). A calendar date passed to `BusinessDayWindow` must
  be the Bahrain date, not the UTC date (Bug 33).
- The Go service is the reference for fee maths; the API must match it.

## Database rules we rely on
- Idempotency comes from a real unique index plus `INSERT ... ON CONFLICT DO NOTHING`, never from
  check-then-insert. Before trusting a comment that says "unique index X exists", look in `db/migrations`
  (Bugs 28, 30, 31, 32, 45).
- Lock a row (`SELECT ... FOR UPDATE`) before deciding based on it (Bugs 9, 19, 32).

## Security
- Security codes and tokens use `crypto` (`crypto.randomInt`), never `Math.random` (Bug 21).
- Every write route needs a role check and must be scoped to the caller's merchant (Bugs 12, 23, 24, 25).
- Never commit secrets. `.env.*` is git-ignored; use the `*.example` files (Bug 26).

## How we fix things (see `.claude/commands/fix-bug.md`)
1. Reproduce with a failing test first.  2. Smallest fix.  3. Show the test now passes.
4. Write the BUGS.md entry: what is wrong, why, what it breaks, the fix, the proof.
5. If an existing test asserted the wrong behaviour, change it and say so in the entry.

## Git
- Commit only when asked; short message saying what and why. Do not add AI co-author or session lines
  (team rule).

## Packages
- `packages/money` was marked "frozen". We did not change it; the bugs lived in callers that did not use it.
