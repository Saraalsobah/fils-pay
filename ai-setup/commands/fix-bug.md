---
description: Reproduce, minimally fix and document one bug in FilsPay
argument-hint: <short description or file>
---
Work on this suspected bug: $ARGUMENTS

1. Read the code and the surrounding comments, ADRs and tests. Treat every claim in them ("unique",
   "safe", "intended", "already checked") as unverified until you confirm it in code or by a query.
2. Write a test that fails because of the bug (reproduce first; do not guess).
3. Make the smallest fix that makes the test pass. Do not refactor.
4. Run the related tests, then `npx tsc --noEmit` (TS) or `go test ./...` (Go).
5. If an old test asserted the wrong behaviour, correct it and say so explicitly.
6. Append an entry to BUGS.md: What is wrong / Why it matters / Fix / Test and evidence / Effect on
   existing data / Leads not changed. Plain language, short.
7. Do not commit unless asked.
