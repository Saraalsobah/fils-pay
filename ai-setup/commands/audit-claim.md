---
description: Check whether a comment, ADR or doc claim in the repo is actually true
argument-hint: <the claim, with file>
---
Verify this claim from the repo: $ARGUMENTS

Find the code, migration or constraint that would make it true. Query the real schema if needed
(`\d table`). Report: TRUE / FALSE / PARTLY, the evidence (file and line, or query output), and what
breaks if it is false. Do not change code in this command.
