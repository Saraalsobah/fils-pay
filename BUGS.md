# FilsPay: findings report

One entry per bug: what is wrong, why it happens, what it breaks, how it was fixed
and how the fix was checked. "Fixed" means a code change plus tests.
"Worked around" means the app is still wrong and only our local setup avoids it.

| # | Bug | Where | Status |
|---|-----|-------|--------|
| 1 | CSV adjustment import reads amounts 10x too small | `apps/api/src/admin/adjustmentCsvParsing.ts` | Fixed |
| 2 | Migration 0054 cannot apply on a fresh database | `db/migrations/0054_views.sql` | Fixed |
| 3 | Migration 0055 cannot apply on a fresh database | `db/migrations/0055_chart_of_accounts_suspense.sql` | Fixed |
| 4 | The built-in dev webhook key is invalid, so the API and the seed refuse to start | `apps/api/src/config.ts` | Worked around |
| 5 | A payment link can be paid after it has expired (FP-187) | `apps/api/src/routes/paymentLinks.ts` | Fixed |
| 6 | Split payouts do not add up to the net payout | `apps/settlement/internal/splits/` | Fixed |
| 7 | Every refund without a `reason` crashes (migration 0070 constraint) | `apps/api/src/payments/processRefund.ts` | Fixed |
| 8 | A refund could exceed what was captured (ceiling used the authorized amount) | `processRefund.ts` | Fixed |
| 9 | Concurrent refunds can together exceed the sale (FP-209, no row lock) | `processRefund.ts` | Fixed |
| 10 | A fully refunded partly-captured sale stays `partially_captured` | `apps/api/src/payments/refundState.ts` | Fixed |
| 11 | Fee reversed across partial refunds does not add up to the fee charged | `processRefund.ts` | Fixed |
| 12 | Any merchant could refund another merchant's transaction | `apps/api/src/refunds/initiateMerchantRefund.ts` | Fixed |
| 13 | Net payout computed through `float32` (a 123,456.789 BD batch paid 3 fils short) | `apps/settlement/internal/settlement/payable.go` | Fixed |
| 14 | `refund_merchant_summary` is always empty (wrong join key) | `db/migrations/0072_refund_merchant_summary.sql` | Fixed |
| 15 | The dashboard would crash on the timeline of any refunded transaction | `apps/web/src/format.ts` | Fixed |
| 16 | **FP-300: refunds** (`POST /v1/refunds` returned 501; settlement ignored refunds) | see the FP-300 section | Built |

Fixes for bugs 1-3 are in commit `12fdf81` (it also contains our local setup files). Bug 5 is in its own commit.

---

## Bug 1: CSV adjustment import reads amounts 10x too small

**File:** `apps/api/src/admin/adjustmentCsvParsing.ts`

**What is wrong:** `4.75` is imported as 475 fils (0.475 BD) instead of 4750 fils. A third
decimal is silently dropped: `4.756` becomes 475 and `0.005` becomes 0.

**Why it happens:** the code called `parseDecimalMinor`, a helper whose default is 2 decimals
(dollars and cents). BD has 3 decimals (1 BD = 1000 fils). The correct parser,
`parseBhdToFils`, already existed in `packages/money` and was not used. This is the mistake
ADR-0001 warns about.

**What it breaks:** every row of an admin "Import adjustments" CSV posts a ledger entry and a
merchant balance change that is 10x too small, with no error shown.

**Fix:** use `parseBhdToFils`. It also rejects more than 3 decimals instead of truncating them.

**Tests and evidence:**
- All 20 existing tests passed while the code was wrong, because they asserted the wrong
  numbers (475, 125, a total of 600, 350, 500). The tests had the bug baked in.
- After the fix, exactly three tests failed, each on a wrong expected number. We corrected
  those expectations (4750, 1250, 6000, 3500, 5000) and added 4 parser tests for 3-decimal
  amounts, a kept third decimal, negative amounts, and rejecting 4 decimals. 24/24 pass and
  `tsc --noEmit` is clean.
- History: commit `9567ea0` (Yousif) already said "the csv import is 10x off... the test is
  scripture"; commit `6f462e1` then marked it intentional.

---

## Bug 2: Migration 0054 cannot apply on a fresh database

**File:** `db/migrations/0054_views.sql`

**What is wrong:** `npm run migrate` stops at 0054 with
`relation "settlement_batch_events" does not exist`.

**Why it happens:** the view `v_unbatched_capture_events` reads from a table that no migration
creates. The handover notes say 0054-0056 were abandoned branches that "no database ever ran",
yet the files are in the migrations folder.

**What it breaks:** a new environment cannot be created from the repo, so the stack cannot be
rebuilt or deployed reproducibly.

**Fix:** "not yet batched" is `transaction_events.settlement_batch_id IS NULL` (migration 0023),
the same rule `CloseBatch` uses. The view now uses that and includes `partially_captured`.

**Evidence:** all 72 migrations applied in order on a clean PostgreSQL 16 after the fix.

**Not changed, to investigate (see leads):** the view `merchant_payable_position` in the same
file.

---

## Bug 3: Migration 0055 cannot apply on a fresh database

**File:** `db/migrations/0055_chart_of_accounts_suspense.sql`

**What is wrong:** it inserts into columns `code`, `account_type` and `description`, which
`chart_of_accounts` does not have, with a kind (`suspense`) its CHECK constraint rejects.

**Why it happens:** written against a table shape that never existed (real columns: `id`,
`name`, `kind`; kinds: asset, liability, revenue).

**What it breaks:** same as bug 2. It was hidden behind bug 2 and appeared once 0054 was fixed.

**Fix:** use the real columns and model the suspense accounts as `asset`, like
`scheme_rounding_residue` in 0007.

**Evidence:** same clean-database run as bug 2.

---

## Bug 4: The built-in dev webhook key is invalid (worked around, not fixed in code)

**File:** `apps/api/src/config.ts` (`DEV_FALLBACK_WEBHOOK_KEY_B64`)

**What is wrong:** the docs say a dev key is used when none is set. That key decodes to 34
bytes, and the code requires exactly 32, so the API and `npm run seed` stop at startup with
`WEBHOOK_SECRET_ENCRYPTION_KEY must base64-decode to exactly 32 bytes, got 34`.

**What it breaks:** the documented "works out of the box" local run does not work.

**Current status:** `ops/docker-compose.local.yml` sets a valid random dev-only key. The
fallback constant itself is still wrong.

---

## Bug 5: A payment link can be paid after it has expired (FP-187)

**Files:** `apps/api/src/routes/paymentLinks.ts`, `apps/web/src/pages/checkout/CheckoutPage.tsx`

**What is wrong:** the public pay endpoint takes a `submittedAt` time from the request body and
uses it to decide whether the link has expired. The checkout page sends the browser's clock.
Anyone can send an old time and pay an expired link.

**Why it happens:** the route's own comment says `submittedAt` is "ignored unless the request is
authenticated with an API key", but the route is public and has no such check. It passed
`submittedAt` straight through to the expiry decision. `docs/ARCHITECTURE.md` described the
client-clock rule as intended ("offline terminals").

**What it breaks:** expired links keep taking money. A merchant who expires a link on purpose
cannot rely on it, and a buyer who saw "expired" can still pay (the report in FP-187).

**Fix:** the route no longer forwards `submittedAt`, so expiry is judged only against the server
clock. The checkout page no longer sends it, and ARCHITECTURE.md now says so.
Trade-off: a buyer who pressed pay just before expiry and retries after it is now expired.
The documented "offline terminal" case is no longer supported on the public route.

**Tests and evidence:** a new route test pays an expired link while sending a `submittedAt` one
hour in the past. Before the fix it returned HTTP 200 (paid). After the fix it returns 410
`payment_link_expired`, the link stays unpaid and no transaction is created. All 13 payment-link
tests pass, and the api and web typechecks are clean.

---

## Bug 6: Split payouts are a few fils off

**What is wrong.** When a parent merchant (e.g. Delta Marketplace) is paid out, its net payout is split between its child merchants by weight. Each child's share was rounded on its own with `ApplyRateFils`, so the shares did not add up to the payout.

**Why.** Rounding each piece separately cannot keep the total. 100 fils split in thirds gives 33 + 33 + 33 = 99, so 1 fil vanishes. 7 fils split in quarters gives 2 + 2 + 2 + 2 = 8, so 1 fil is invented. The existing test only used amounts that divide evenly, so it never caught this. A second flaw: the parent's cached balance was lowered by the sum of the shares, not by the batch's net payout, so any error also made the cache drift. The weights were never checked to sum to 10000 bps either (FP-250).

**What it breaks.** Merchants are paid a few fils too little or too much on every uneven split, and the ledger, `settlement_batch_splits` and the batch no longer reconcile. It is the "splits always a few fils short" item on the finance memo.

**Fix.** `ChildShares` now uses largest-remainder allocation: everyone gets the whole-fils part, and the leftover fils go one each to the biggest fractional remainders (ties to the earlier child, so it is deterministic). `PayoutSplitBatch` refuses to pay if the weights do not sum to 10000, checks that the shares equal the net payout, and lowers the cache by the net payout.

**Evidence.** New tests `TestChildShares_UnevenAmountsStillSumToNet`, `TestChildShares_Deterministic` and `TestValidateWeights`. Before the fix 6 of 8 uneven cases failed; afterwards all pass.

## Bugs 7 to 12: the refund processor (`apps/api/src/payments/processRefund.ts`)

The previous developer called this helper "complete, tested". Their own tests did not even pass
on a fresh database (7 of 10 failed), and writing tests for each of these first showed the rest.

**7. Refunds without a reason crash.** *Why:* migration 0070 added `CHECK (reason IS NOT NULL)`,
but the code inserted `NULL` when no reason was given. *Breaks:* every refund that does not state a
reason ends in a database error. *Fix:* store `'unspecified'` (`COALESCE($6, 'unspecified')`).

**8. Over-refund.** *Why:* the refundable amount was `authorized - refunded`; it must be
`captured - refunded`. *Breaks:* on a 10,000 fils sale of which 4,000 was captured, a 6,000 refund
was accepted: the merchant gives back money the cardholder was never charged. *Fix:* use the captured
amount. *Test:* `a partially captured transaction cannot refund more than it captured`.

**9. Concurrent refunds (FP-209).** *Why:* the transaction row was read without a lock, in a
transaction separate from the one that wrote the refund, so parallel requests all saw the same
`refunded_fils`. *Breaks:* we sent 6 refunds of 3,000 at once against a 10,000 sale and all 6 were
accepted (18,000 fils refunded). *Fix:* one transaction with `SELECT ... FOR UPDATE` taken before the
check and held through the acquirer call, exactly how `captureTransaction` already works. *Test:*
`concurrent refunds cannot together exceed the captured amount (FP-209)` now accepts exactly 3.

**10. Wrong status after a full refund.** *Why:* `nextStatusAfterRefund` returned
`partially_captured` whenever the sale was only partly captured, even after everything captured had
been refunded (a code comment even doubted it). *Breaks:* finance's rule is "refunded when every fils we
captured went back"; the dashboard showed the wrong status. *Fix:* derive the status from the refunded
total against the captured amount, and release any active authorization hold once refunded.

**11. Fee reversal drift.** *Why:* the fee given back was rounded separately for each partial refund
(`round(fee x refund / captured)`), and rounding errors do not cancel. *Breaks:* three refunds of 333 on a
999 fils sale gave back 8 + 8 + 8 = 24 fils of a 25 fils fee; the merchant stays 1 fil short, and
the reconciliation drifts. *Fix:* reverse the fee cumulatively: the fee due for everything refunded so
far, minus what was already given back, so the last refund lands exactly on the fee charged.

**12. Cross-merchant refund.** *Why:* `initiateMerchantRefund` looked the transaction up by id only and
refunded it for whichever merchant owned it; a test for it had been deleted as "redundant".
*Breaks:* any merchant (or API key) could refund any other merchant's transaction if it knew its id.
*Fix:* the lookup, and the row lock, are scoped to the caller's own merchant (404 otherwise).

## Bug 13: Net payout through `float32` (`settlement/payable.go`)

*Why:* `NetPayableFils` turned fils into `float32` BD and back. A `float32` holds integers exactly only up to
16,777,216, so a batch of 16,777 BD or more can be off by fils. *Breaks:* a batch of 123,456.789 BD with a
3,086.419 BD fee paid out 120,370.367 instead of 120,370.370. *Fix:* integer subtraction.
*Test:* `TestNetPayableFils_IsExactIntegerSubtraction`.

## Bug 14: `refund_merchant_summary` is always empty

*Why:* the view joined `transactions t ON t.id = r.id`: a refund's own id against a transaction id, which never
matches. *Fix:* join on `r.transaction_id`. After the fix the view counted all 123 refunds from our
test run. (Nothing refreshes or reads this view yet.)

## Bug 15: Negative amounts crash the dashboard

*Why:* `bhd()` called `toFils()` without `allowNegative`, and refund events on the transaction timeline carry
negative amounts. *Breaks:* the detail page of every refunded transaction would have thrown. *Fix:* allow
negatives in the display helper.

## FP-300: refunds, built end to end

What the ticket asked for, and where it is:

| Requirement | How |
|---|---|
| Money goes back to the cardholder | `acquirer.refund(...)` is called inside the locked transaction; a decline answers 402 and writes nothing, an error answers 502 and leaves the key retryable |
| Reverse the right share of the MDR | cumulative fee reversal (Bug 11), booked as ledger legs `platform_fee_revenue` debit / `merchant_payable` credit |
| Adjust the merchant's next settlement batch | `CloseBatch` claims unbatched refunds and subtracts them from the payout (migration 0073: `refunds_fils`, `refund_fee_reversed_fils`). It takes the oldest first and stops at the first one the day's money cannot cover, so a payout is never negative and a refund is never lost; the rest wait for the next batch. `RecalculateMDR` keeps the deduction |
| `refund.succeeded` to the merchant webhook | added to the dispatcher list **and** `buildEnvelope` (adding it to the list alone would have thrown and stalled the whole webhook queue) |
| Timeline, settlement report, reconciliation | timeline events `refund_partial` / `refunded`; batch report shows the refund lines; the reconciliation subtracts refunds not yet batched, so a period with refunds still explains to zero |

The route is `POST /v1/refunds` with an `Idempotency-Key` header (the old draft used `crypto.randomUUID()`,
a new key per request, which defeats idempotency). Body: `transactionId`, optional `amountFils` (whole
fils, left out = everything still refundable) and `reason`. Allowed: an API key, or a signed-in `owner` or
`finance` user. An admin's "view as merchant" session is refused. The dashboard refund drawer was
restored and points at the same route; it reuses one key for a retry of the same refund and makes a new
one after a definite answer.

Checks: API tests 381 of 382 pass (the one failure, a webhook-retry timing test, fails the same way
without our changes); Go tests all pass, including 6 new ones for refund netting, and a test that after
capture, refund, close and payout the cached balance and the balance rebuilt from the ledger agree (both 0).

## Setup problems found (not app bugs)

- `ops/Dockerfile.node` and `ops/Dockerfile.go` are referenced by the compose file and the ops
  README but were never committed (checked all 57 commits). We wrote replacements.
- The API sends no CORS headers, so the Vite frontends cannot call it directly. We added a `/v1`
  proxy in both Vite configs (with `.env.local` files setting the API base URL to empty).

## Leads: read in the code, not yet reproduced or fixed

- Split payout path does not call `UpdateLifetimePayoutMonitoringEstimate` (the normal `PayoutBatch` does), and `ApplyPayout` silently does nothing if a merchant has no `merchant_balances` row.

- OTP codes come from `Math.random()` (`apps/api/src/lib/random.ts`).
- Two-person credit approval compares `displayName` instead of the admin user id.
- The scheme export `amount` column is computed from the untruncated gross, not the truncated
  amount.
- The "Rebuild cached balances" button reads `merchant_payable_position`, a view over
  `scheme_export_lines`, instead of the ledger.
- Discounts: `parsePromotionalDiscountFils` in `payments/discountAdjustment.ts` uses
  `parseFloat(...) * 100`, but nothing calls it (dead code). Separately, the capture-time rebate
  applies the discount to the fee, while the Go settlement applies it to the amount first. The
  meeting notes say "Go is the reference for fees, capture.ts follows". The two differ by up to a
  fil per capture (602 fils at 275 bps with a 12.5% discount: 15 fils in the API, 14 in Go), and
  payment-link captures never get the API rebate at all.
- Uploading the same adjustment CSV twice applies it twice (no idempotency, despite a comment
  assuming one).
- `ops/.env.docker` contains an acquirer callback signing secret, and `.gitignore` does not
  ignore that file.
- Capture and void are only hidden from `support` in the UI; the API lets any authenticated merchant
  actor call them, including an admin's "view as merchant" session (`requireMerchantAuth` does not
  block impersonation on writes, and `requireMerchantWriterActor` then records it as a normal merchant
  session). Refunds are gated to `owner`/`finance`; capture and void are not.
- `refund.succeeded` is deliberately NOT added to the reporting consumer: `applyDailySummaryRollup` writes
  `refund_count` / `refund_gross_fils` to `merchant_daily_volume`, columns no migration creates, so
  adding the event type (as a code comment suggests) would crash the consumer on the first refund.
- A merchant whose refunds exceed everything they ever capture is never paid negative; the refunds wait
  unclaimed. The platform has to recover that money some other way.
- If a refund is carried into a later batch (because its own day could not cover it), the reconciliation
  for the refund's own period shows that amount as a gap.
- Webhook retry: `backoffDelayMs` adds +/-10% random jitter but the dispatcher test expects an exact 1000 ms,
  so that test fails (it also fails without our changes).
- `merchants.refunds_enabled`: the comment in migration 0052 says NULL means "disabled", the code and
  its other comment treat NULL as "no hold". We left the code as is.

## Login / OTP security (bugs 17-22)

| # | Bug | Where | Fix |
|---|-----|-------|-----|
| 17 | A password-only (pre-OTP) session cookie was accepted as a full login: `live_sessions` view has no `authenticated = true` filter, so the OTP step could be skipped entirely | `auth/sessions.ts` `lookupSession` | added `AND s.authenticated = true` |
| 18 | OTP was sent to / session created for `findOtpRecipient(email)` = first user with that email across ALL merchants, so logging into merchant B could give a session for merchant A | `routes/auth.ts` login | recipient is the user that passed the password check |
| 19 | Attempt limit was check-then-increment: 40 parallel wrong guesses all read `attempt_count = 0`, so the 5-guess limit did not hold (6-digit code brute-forceable). Same race on admin login, whose comment wrongly said the row was locked | `routes/auth.ts`, `routes/adminAuth.ts` `/otp/verify` | one atomic `UPDATE ... SET attempt_count = attempt_count + 1 WHERE attempt_count < max_attempts` reserves the guess before the code is checked |
| 20 | "Resend" reset the guess budget (comment claimed it inherits attempt_count; code did not), giving unlimited guesses | `auth/otp.ts` `issueChallenge`, `routes/auth.ts` resend | new challenge inherits the old `attempt_count` |
| 21 | OTP codes and payment-link tokens came from `Math.random()` (predictable, not a CSPRNG) | `lib/random.ts` | `crypto.randomInt` |
| 22 | `OTP_DEV_EXPOSE=true` in production returned the login code in the API response | `config.ts` | `loadConfig` refuses to start in production with it on |

Tests: `apps/api/src/routes/authOtp.test.ts` (7 tests, 6 failed before the fixes).

## Authorization (bugs 23-25)

| # | Bug | Where | Fix |
|---|-----|-----|-----|
| 23 | Capture and void had only `requireMerchantAuth`, no role check: a `support` user could move money (the void route even had a `TODO role check?`) | `routes/transactions.ts` | `requireMerchantRole("owner","finance")`, same as refunds and payment links |
| 24 | An admin "view as merchant" grant with the admin `finance` role maps to merchant role `finance`, and `requireMerchantWriterActor` turned it into a normal `merchant_session`, so an impersonating admin could capture/void/create links and webhooks, recorded as the merchant (comment said "impersonation can't reach write routes") | `auth/requireMerchantAuth.ts` | `requireMerchantWriterActor` throws 403 for `admin_impersonation`, one central place for every write route |
| 25 | Cancelling a payment link used only the link id: merchant A could cancel merchant B's link (the route checked the URL merchant, not the link's owner) | `paymentLinks/cancel.ts` | UPDATE and lookup also filter `merchant_id` from auth; other merchant's id now gives 404 |

Tests: `apps/api/src/routes/authz.test.ts` (3 tests, all failed before the fixes).

## Committed secret (bug 26)

| # | Bug | Where | Fix |
|---|-----|-----|-----|
| 26 | `ops/.env.docker` (holds `ACQUIRER_CALLBACK_SIGNING_SECRET`) was committed to git. Its header says "gitignored like .env" and a note says `.env` matches `.env.docker` as a prefix. Both are wrong: a gitignore pattern matches whole names, so only `.env` itself was ignored. Anyone with repo read access (judges, collaborators) can read the secret from history | `.gitignore`, `ops/.env.docker` | `.gitignore` now has `.env.*` (keeping `.env.*.example`); the file is untracked (`git rm --cached`, local copy kept); `ops/.env.docker.example` documents the variables with placeholders. **The old value is still in git history, so it must be treated as leaked: production uses freshly generated secrets, never this value.** |

## Inbound acquirer callbacks (bugs 27-29, FP-201)

| # | Bug | Where | Fix |
|---|-----|-------|-----|
| 27 | The public `POST /v1/acquirer/callbacks` accepted **unsigned** requests (`ACQUIRER_CALLBACK_REQUIRE_SIGNATURE` defaulted to false; the app comment "inboundVerify rejects unsigned requests" was false). The signature is the only authentication on that endpoint. Also an **empty secret** (the default outside production) made the HMAC key empty, so anyone could compute a valid signature | `webhooks/inboundVerify.ts`, `routes/acquirerCallbacks.ts`, `config.ts` | signature always required; empty secret never verifies; the optional flag is removed |
| 28 | Duplicate callbacks were stored again each time (FP-201, the 2026-05-14 incident). The migration comment says a unique index (FP-238) and `processed_events` exist; neither does | `db/migrations/0074`, `acquirer/callbacks.ts` | existing duplicates removed (earliest kept), `UNIQUE (callback_id)`, insert uses `ON CONFLICT DO NOTHING`, so a redelivery returns 200 without a second row |
| 29 | `outcome` was not validated (comment said it was), any string was stored | `routes/acquirerCallbacks.ts` | 400 unless `cleared` or `confirmed_fraud` |

Checked and fine: outbound `webhooks/sign.ts` (HMAC over `timestamp.canonicalJson`, constant-time compare). The comment worrying about a timing oracle on the timestamp is not a real problem because the timestamp is inside the MAC.
Not changed (lead): inbound callbacks have no freshness window; with the unique index a replay is now harmless (it only appends an informational note).

## Duplicate payout notifications (bugs 30-31, incident 2026-08-21)

The postmortem blamed a reporting-worker restart replaying NOTIFYs ("retry artefact"). AM's question in ADMIN.md was right: the two deliveries had different outbox event ids, so it was not the same rows replayed. Two real causes:

| # | Bug | Where | Fix |
|---|-----|-------|-----|
| 30 | `EnqueuePayoutNotifications` relies on `NOT EXISTS`, which two overlapping scans (daemon tick + `run-batch`, or two daemons) both pass, so two `settlement.paid` outbox events (different ids) are created for one batch. A comment claimed a unique index on `(event_type, aggregate_id)` prevented it; that index never existed. | `settlement/payout_notify.go`, migration 0075 | partial unique index on `outbox_events(aggregate_id) WHERE event_type='settlement.paid'` + `ON CONFLICT DO NOTHING`; the count only counts rows really inserted |
| 31 | The payout disbursement record (the payout-rail instruction) is written as a side effect of each webhook **delivery** (attempt 0), so a merchant with 2 endpoints, or a replay, writes 2 disbursements for one batch. That is the "two disbursement records each" in the incident | `webhooks/payoutDisbursement.ts`, migration 0075 | unique index on `settlement_payout_disbursements(settlement_batch_id)` + `ON CONFLICT DO NOTHING` |

Tests: Go `TestEnqueuePayoutNotificationsConcurrentScansEnqueueOnce` (12 concurrent scans -> 1 event) and TS `recordPayoutDisbursementEffect is idempotent per batch`.
Lead (not changed): the disbursement is only recorded when a webhook delivery runs, so a merchant with no webhook endpoint never gets a disbursement record. It should be written when the batch is paid, not when a webhook is sent.

## Payment link charged twice (bug 32, incident 2026-05-14)

| # | Bug | Where | Fix |
|---|-----|-------|-----|
| 32 | The postmortem blamed duplicate acquirer callbacks and said the claim in `pay.ts` was "ruled out" (confirmed by an AI review). It is not safe: a `reserved` link older than the timeout (60 s) can be re-claimed, while the first payer's authorize+capture is still running with no lock. The second payer re-claims, pays and finalizes first; the first payer's finalize then matches 0 rows, the code logs "unreachable" and **still answers 200 "paid"** (a comment from FH said exactly this and was dismissed). Both cards are charged. The "unique constraint, one successful capture per link" (FP-202) also does not exist. Reproduced with a test whose first capture takes 2.5 s with a 1 s timeout: both payers got 200 and 10,000 fils net was captured for a 5,000 fils link | `paymentLinks/pay.ts`, migration 0076 | each claim gets its own `reservation_id`; finalize and release only work for the current holder (a stale request can no longer free someone else's reservation); a payer who loses the link after capturing is **refunded automatically** (system refund, `refunds.created_by_type` now allows `system`) and gets 409 `payment_link_already_paid` |

Test: `paymentLinks/payRace.test.ts` (failed before: `[200,200]`; now one 200, one 409, net captured = one link amount).
Note: the postmortem root cause (duplicate callbacks) was real but is a separate bug (27/28); callbacks only append informational notes and never touched link status.

## Daily close runs at 3am instead of just after midnight (bug 33)

| # | Bug | Where | Fix |
|---|-----|-------|-----|
| 33 | The daemon passed `time.Now().UTC()` to `BusinessDayWindow`, which reads the calendar date in the argument's own zone. Between 00:00 and 03:00 Bahrain (21:00-24:00 UTC) the UTC date is still the previous day, so the daemon believed it was a day earlier: it "closed" the already-closed previous date and the real close only ran after 03:00 Bahrain, when the UTC date flipped. Matches the logs ("close ~03:15 local not 00:15") that AM dismissed with "whatever, it runs", and MK's comment "UTC here is fine, BusinessDayWindow converts to Bahrain" is false (it does not convert; its argument is a calendar date) | `scheduler/daemon.go`, `settlement/window.go` | new `BahrainCalendarDate(now)` and a pure `dueBusinessDate(now, delay)`; the daemon decides "today" from the Bahrain date |

Test: `scheduler/daemon_test.go` `TestDueBusinessDate` (fails on the old logic: due during the grace period, wrong date at 00:15 and 02:59 Bahrain).
Deliberately NOT changed: `BusinessDayWindow` itself keeps its calendar-date contract (the CLI `--date` and the existing window tests depend on it); the fix is in the caller. The "restart at 00:05 closes early" claim in a comment is false: the boot run goes through the same due check.

## MDR recalculation rewrote paid batches (bug 34)

| # | Bug | Where | Fix |
|---|-----|-------|-----|
| 34 | `RecalculateMDR` selected every batch with `status <> 'open'`, so it also rewrote batches that were already **paid out**: it changed their `fee_fils`/`net_payout_fils` after the money had left, posted ledger adjustments against them and moved the balance cache for a payout that had already happened. The batch row then disagreed with what was actually paid and disbursed. The type comment even says the original batch's figures "stay as they were paid". The admin docs call the endpoint "safe" and finance runs it after every rate change | `settlement/recalculate_mdr.go` | only `status = 'closed'` (not yet paid) batches are recalculated |

Test: `TestRecalculateMDR_PaidBatchIsLeftAlone` (before: a paid batch's fee went 1,250 -> 2,000 fils).
Lead (not changed): a rate correction on already-paid days is then never recovered; finance needs an explicit adjustment posted into the current open batch.

## "Recompute statuses" switched sandbox merchants into live settlement (bug 35)

| # | Bug | Where | Fix |
|---|-----|-------|-----|
| 35 | The admin button "Recompute transaction statuses" (documented as "safe to run more than once") also ran `reconcileSandboxFlag`, which set `merchants.test_mode = false` whenever the merchant "had no open authorizations". That check is always true: the recompute query already excludes `authorized` transactions, so `openAuthorizations` is always 0. Result: pressing the button once on a sandbox merchant (e.g. Gamma Hospitality, "must stay out of real settlement until they go live") put them into the next real settlement run, with no audit of the go-live and no approval. `CloseBatch` and the daily run skip `test_mode` merchants, which is the only thing keeping sandbox activity out of real payouts | `routes/adminMerchantsRecompute.ts`, `admin/merchantFlags.ts` | the recompute no longer touches `test_mode`; the helper is kept but marked unused (`flagsUpdated` stays in the response as `[]` for the admin UI) |

Test: `routes/adminRecomputeSandbox.test.ts` (before: `test_mode` flipped true -> false).
Lead (not changed): there is still no explicit, audited "go live" action for a sandbox merchant; one should replace the old side effect.

## "Rebuild cached balances" button wrote the wrong balance (bug 36)

| # | Bug | Where | Fix |
|---|-----|-------|-----|
| 36 | The admin console's "Rebuild cached balances" (documented as "safe, only rewrites the cache, run it whenever a balance looks off") calls `ledger.RefreshBalanceCache`, which rebuilds each merchant's balance from the view `merchant_payable_position` = sum of `scheme_export_lines`. Export lines are gross, truncated to 2 decimals, and know nothing about fees, refunds, payouts or manual adjustments, so pressing the button overwrote a correct cache with a wrong number for every merchant. The ledger (`merchant_payable` account) is the source of truth; the CLI `rebuild-balances` already used it. A visible test even asserted the export-derived number ("FH: 12000 = export total = what support sees") | `internalapi/server.go` | the endpoint now calls `RebuildAllBalances` (from the ledger). Also fixed the TODO in that function: each cache row is locked `FOR UPDATE` before the ledger is summed, so a concurrent close/payout increment is not clobbered |

Test: `TestRebuildBalances_UsesTheLedgerNotSchemeExportLines` (merchant owed 12,000 with 5,000 already paid out: ledger says 7,000; the button used to write 12,000).
Not changed: `RefreshBalanceCache` and its two tests are left as they were (nothing calls it any more). ADMIN.md also says "the nightly recompute does the same at 02:00"; nothing in the code does that (lead: do not rely on it).

## Money counters too narrow (bugs 37-38)

| # | Bug | Where | Fix |
|---|-----|-------|-----|
| 37 | `platform_stats.total_processed_fils` was a 32-bit `INTEGER` (and `int32` in Go) while the volume-tier threshold is 2,000,000,000 fils. INTEGER tops out at 2,147,483,647 fils (2.1M BD); the comment "INTEGER in PostgreSQL is 64-bit" (from an AI answer) is false. Past that point the Go addition wrapped negative (reproduced: 2,147,000,000 + 1,000,000,000 stored as **-1,147,967,296**), which silently switched off the platform-wide 15 bps MDR bonus for every merchant, and the counter was garbage from then on | migration 0077, `settlement/platform_volume.go` | `BIGINT` column, `int64` in Go end to end |
| 38 | `merchants.lifetime_net_payout_monitoring_estimate` was a `REAL` (float32) fed `float32(netPayout)`: not exact above 16,777,216 fils (16,777 BD), so adding small payouts to a big total was rounded away (reproduced: 100,000,000 + 1 + 3 + 4,700 stored as 1.00004704e+08, not exact). The sub-merchant **split payout path never updated it at all**, so split merchants' figure stopped growing. The comment "nobody reads it" does not make a money total approximate | migration 0077, `settlement/payout_estimate.go`, `splits/allocate.go` | `BIGINT` and integer fils; the migration recomputes every merchant's value from their paid batches; the split path now updates it too (inlined, because `settlement` imports `splits`); `EstimateMonthlyPayout` also integer |

Tests: `TestRecordPlatformProcessedVolume_CrossesInt32Max`, `TestUpdateLifetimePayoutMonitoringEstimate_LargeValuesStayExact`. The first one resets the shared counter in cleanup; leaving it above the threshold made every later settlement test get the 15 bps bonus.
Effect on existing data: the migration rewrites the lifetime estimate for every merchant from `settlement_batches` (it was only an approximation before); `platform_stats` keeps its value.
