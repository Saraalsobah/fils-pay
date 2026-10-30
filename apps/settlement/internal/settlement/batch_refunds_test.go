package settlement

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/filspay/settlement/internal/ledger"
	"github.com/filspay/settlement/internal/money"
)

// insertRefund inserts one succeeded refunds row, the way apps/api's
// processRefund would have, against an existing transaction.
func insertRefund(t *testing.T, pool *pgxpool.Pool, merchantID, txnID uuid.UUID, amountFils, feeReversedFils money.Fils, occurredAt time.Time) uuid.UUID {
	t.Helper()
	var id uuid.UUID
	err := pool.QueryRow(context.Background(), `
		INSERT INTO refunds
		  (transaction_id, merchant_id, amount_fils, fee_reversed_fils, status, acquirer_reference,
		   reason, created_by_type, created_by_id, occurred_at)
		VALUES ($1, $2, $3, $4, 'succeeded', $5, 'test', 'merchant_api_key', $6, $7)
		RETURNING id
	`, txnID, merchantID, int64(amountFils), int64(feeReversedFils), "acq-refund-"+uuid.New().String(), uuid.New(), occurredAt).Scan(&id)
	if err != nil {
		t.Fatalf("insertRefund: %v", err)
	}
	return id
}

func refundBatchID(t *testing.T, pool *pgxpool.Pool, refundID uuid.UUID) *uuid.UUID {
	t.Helper()
	var id *uuid.UUID
	if err := pool.QueryRow(context.Background(), `SELECT settlement_batch_id FROM refunds WHERE id = $1`, refundID).Scan(&id); err != nil {
		t.Fatalf("refundBatchID: %v", err)
	}
	return id
}

// A refund inside the day comes off the payout: net = gross - fee - refund + fee given back.
func TestCloseBatch_RefundsReduceTheNetPayout(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 10, 0, 0, 0, 0, time.UTC)
	start, end := BusinessDayWindow(businessDate)

	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour)) // fee 250, net 9750
	inside := insertRefund(t, pool, merchantID, txnID, 4_000, 100, start.Add(2*time.Hour))
	nextDay := insertRefund(t, pool, merchantID, txnID, 1_000, 25, end.Add(time.Hour))

	res, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if res.GrossFils != 10_000 || res.FeeFils != 250 {
		t.Errorf("gross/fee = %d/%d, want 10000/250 (refunds must not alter the captured totals)", res.GrossFils, res.FeeFils)
	}
	if res.RefundCount != 1 || res.RefundFils != 4_000 || res.RefundFeeReversedFils != 100 {
		t.Errorf("refunds = %d x %d (fee back %d), want 1 x 4000 (fee back 100)", res.RefundCount, res.RefundFils, res.RefundFeeReversedFils)
	}
	if want := money.Fils(10_000 - 250 - 4_000 + 100); res.NetPayoutFils != want {
		t.Errorf("NetPayoutFils = %d, want %d", res.NetPayoutFils, want)
	}
	if got := refundBatchID(t, pool, inside); got == nil || *got != res.BatchID {
		t.Errorf("the in-window refund should be claimed by the batch, got %v", got)
	}
	if got := refundBatchID(t, pool, nextDay); got != nil {
		t.Errorf("a refund after the window must not be claimed, got %v", got)
	}

	// The stored row carries the same figures the result reports.
	var net, refunds, back int64
	if err := pool.QueryRow(context.Background(),
		`SELECT net_payout_fils, refunds_fils, refund_fee_reversed_fils FROM settlement_batches WHERE id = $1`, res.BatchID,
	).Scan(&net, &refunds, &back); err != nil {
		t.Fatal(err)
	}
	if net != 5_850 || refunds != 4_000 || back != 100 {
		t.Errorf("stored net/refunds/back = %d/%d/%d, want 5850/4000/100", net, refunds, back)
	}
}

// The payout never goes negative: a refund bigger than the day's money waits
// (unclaimed) and is netted by the next batch that can afford it.
func TestCloseBatch_RefundBiggerThanTheDayWaitsForTheNextBatch(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	day1 := time.Date(2026, 4, 11, 0, 0, 0, 0, time.UTC)
	day2 := time.Date(2026, 4, 12, 0, 0, 0, 0, time.UTC)
	start1, _ := BusinessDayWindow(day1)
	start2, _ := BusinessDayWindow(day2)

	txn1, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 1_000, start1.Add(time.Hour)) // net 975
	big := insertRefund(t, pool, merchantID, txn1, 5_000, 125, start1.Add(2*time.Hour))      // costs 4875

	first, err := CloseBatch(context.Background(), pool, merchantID, day1)
	if err != nil {
		t.Fatalf("CloseBatch day1: %v", err)
	}
	if first.NetPayoutFils != 975 || first.RefundCount != 0 {
		t.Errorf("day1 net/refunds = %d/%d, want 975/0 (never negative, refund deferred)", first.NetPayoutFils, first.RefundCount)
	}
	if refundBatchID(t, pool, big) != nil {
		t.Fatal("the refund must stay unclaimed after day 1")
	}

	insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start2.Add(time.Hour)) // net 9750
	second, err := CloseBatch(context.Background(), pool, merchantID, day2)
	if err != nil {
		t.Fatalf("CloseBatch day2: %v", err)
	}
	if second.RefundCount != 1 || second.RefundFils != 5_000 || second.RefundFeeReversedFils != 125 {
		t.Errorf("day2 refunds = %d x %d (fee back %d), want 1 x 5000 (fee back 125)", second.RefundCount, second.RefundFils, second.RefundFeeReversedFils)
	}
	if want := money.Fils(9_750 - 4_875); second.NetPayoutFils != want {
		t.Errorf("day2 NetPayoutFils = %d, want %d", second.NetPayoutFils, want)
	}
	if got := refundBatchID(t, pool, big); got == nil || *got != second.BatchID {
		t.Errorf("the deferred refund should now be claimed by day 2's batch, got %v", got)
	}
}

// Refunds are taken oldest first and the walk stops at the first one that
// does not fit, so a later small refund never jumps the queue.
func TestCloseBatch_RefundsAreTakenOldestFirstAndStopAtTheFirstThatDoesNotFit(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 13, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 1_000, start.Add(time.Hour)) // net 975
	r1 := insertRefund(t, pool, merchantID, txnID, 500, 0, start.Add(2*time.Hour))
	r2 := insertRefund(t, pool, merchantID, txnID, 9_000, 0, start.Add(3*time.Hour))
	r3 := insertRefund(t, pool, merchantID, txnID, 100, 0, start.Add(4*time.Hour))

	res, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	if res.RefundCount != 1 || res.NetPayoutFils != 475 {
		t.Errorf("refunds/net = %d/%d, want 1/475", res.RefundCount, res.NetPayoutFils)
	}
	if refundBatchID(t, pool, r1) == nil {
		t.Error("r1 (oldest, fits) should be claimed")
	}
	if refundBatchID(t, pool, r2) != nil || refundBatchID(t, pool, r3) != nil {
		t.Error("r2 does not fit and r3 must not jump the queue: both stay unclaimed")
	}
}

// Closing the same day twice must not net the refunds twice.
func TestCloseBatch_RefundsAreNettedOnceOnReClose(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 14, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour))
	insertRefund(t, pool, merchantID, txnID, 2_000, 50, start.Add(2*time.Hour))

	first, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatal(err)
	}
	second, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatal(err)
	}
	if !second.AlreadyClosed {
		t.Fatal("second close must be an idempotent no-op")
	}
	if second.NetPayoutFils != first.NetPayoutFils || second.RefundFils != first.RefundFils ||
		second.RefundFeeReversedFils != first.RefundFeeReversedFils || second.RefundCount != first.RefundCount {
		t.Errorf("re-close changed the figures: %+v vs %+v", second, first)
	}
}

// Recomputing the fee on an already-closed batch must keep the refund
// deduction; it used to rebuild net as gross - fee and silently drop it.
func TestRecalculateMDR_KeepsTheRefundDeduction(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 15, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour))
	insertRefund(t, pool, merchantID, txnID, 4_000, 100, start.Add(2*time.Hour))
	res, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatal(err)
	}
	if res.NetPayoutFils != 5_850 {
		t.Fatalf("setup: net = %d, want 5850", res.NetPayoutFils)
	}

	if _, err := pool.Exec(context.Background(), `UPDATE merchants SET mdr_bps = 300 WHERE id = $1`, merchantID); err != nil {
		t.Fatal(err)
	}
	if _, err := RecalculateMDR(context.Background(), pool, merchantID, businessDate, businessDate.AddDate(0, 0, 1)); err != nil {
		t.Fatalf("RecalculateMDR: %v", err)
	}

	var fee, net int64
	if err := pool.QueryRow(context.Background(),
		`SELECT fee_fils, net_payout_fils FROM settlement_batches WHERE id = $1`, res.BatchID).Scan(&fee, &net); err != nil {
		t.Fatal(err)
	}
	// fee 3.00% of 10,000 = 300; net = 10000 - 300 - 4000 + 100
	if fee != 300 || net != 5_800 {
		t.Errorf("after recalculation fee/net = %d/%d, want 300/5800", fee, net)
	}
}

// The month-end tie-out Huda asked for: after capture, refund, close and
// payout, the incremental balance cache and the balance rebuilt from the
// ledger agree, and both are zero.
func TestRefundCloseAndPayout_CacheMatchesTheLedger(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 4, 16, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	txnID, _ := insertCaptureEvent(t, pool, merchantID, mdrBps, 10_000, start.Add(time.Hour)) // +10000 -250
	refundAt := start.Add(2 * time.Hour)
	insertRefund(t, pool, merchantID, txnID, 4_000, 100, refundAt)
	// The ledger legs apps/api's processRefund posts alongside the refunds row.
	groupID := uuid.New()
	if _, err := pool.Exec(ctx, `
		INSERT INTO ledger_entries
		  (entry_group_id, merchant_id, transaction_id, account_id, direction, amount_fils, occurred_at, description)
		VALUES
		  ($1, $2, $3, 'merchant_payable',     'debit',  4000, $4, 'refund: gross'),
		  ($1, $2, $3, 'card_scheme_clearing', 'credit', 4000, $4, 'refund: gross'),
		  ($1, $2, $3, 'platform_fee_revenue', 'debit',   100, $4, 'refund: MDR fee reversal'),
		  ($1, $2, $3, 'merchant_payable',     'credit',  100, $4, 'refund: MDR fee reversal')
	`, groupID, merchantID, txnID, refundAt); err != nil {
		t.Fatalf("insert refund ledger legs: %v", err)
	}

	closed, err := CloseBatch(ctx, pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}
	var afterClose int64
	if err := pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&afterClose); err != nil {
		t.Fatal(err)
	}
	if afterClose != 5_850 || closed.NetPayoutFils != 5_850 {
		t.Errorf("after close cache/net = %d/%d, want 5850/5850", afterClose, closed.NetPayoutFils)
	}
	ledgerBefore, err := ledger.RebuildMerchantBalance(ctx, pool, merchantID)
	if err != nil {
		t.Fatalf("RebuildMerchantBalance: %v", err)
	}
	if int64(ledgerBefore) != afterClose {
		t.Errorf("ledger says %d is payable but the cache says %d", ledgerBefore, afterClose)
	}

	if _, err := PayoutBatch(ctx, pool, closed.BatchID); err != nil {
		t.Fatalf("PayoutBatch: %v", err)
	}
	var afterPayout int64
	if err := pool.QueryRow(ctx, `SELECT cached_payable_fils FROM merchant_balances WHERE merchant_id = $1`, merchantID).Scan(&afterPayout); err != nil {
		t.Fatal(err)
	}
	ledgerAfter, err := ledger.RebuildMerchantBalance(ctx, pool, merchantID)
	if err != nil {
		t.Fatal(err)
	}
	if afterPayout != 0 || ledgerAfter != 0 {
		t.Errorf("after payout cache/ledger = %d/%d, want 0/0", afterPayout, ledgerAfter)
	}
}
