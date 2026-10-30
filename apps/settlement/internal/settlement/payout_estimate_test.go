package settlement

import (
	"context"
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// TestUpdateLifetimePayoutMonitoringEstimate_SmallValuesExact proves the
// accumulator is wired correctly: three successive payouts land on the
// exact sum of their net figures.
// FH: float32 exact up to 2^24 so small values are fine; big ones drift but nobody reads it
func TestUpdateLifetimePayoutMonitoringEstimate_SmallValuesExact(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for _, net := range []money.Fils{1_000, 2_500, 47_500} {
		if err := UpdateLifetimePayoutMonitoringEstimate(ctx, tx, merchantID, net); err != nil {
			t.Fatalf("UpdateLifetimePayoutMonitoringEstimate(%d): %v", net, err)
		}
	}

	var got int64
	err = tx.QueryRow(ctx, `
		SELECT lifetime_net_payout_monitoring_estimate FROM merchants WHERE id = $1
	`, merchantID).Scan(&got)
	if err != nil {
		t.Fatalf("read back estimate: %v", err)
	}
	if got != 51_000 {
		t.Fatalf("lifetime_net_payout_monitoring_estimate = %v, want exactly 51000 (1000 + 2500 + 47500)", got)
	}
}

// A float32 stops being exact above 2^24 (16,777,216 fils = 16,777 BD): adding a small
// payout to a large running total is silently rounded away. Money totals are integer fils.
func TestUpdateLifetimePayoutMonitoringEstimate_LargeValuesStayExact(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	merchantID := insertActiveMerchant(t, pool, 250)
	if _, err := pool.Exec(ctx, `UPDATE merchants SET lifetime_net_payout_monitoring_estimate = 100000000 WHERE id = $1`, merchantID); err != nil {
		t.Fatalf("seed: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck
	for _, net := range []money.Fils{1, 3, 4_700} {
		if err := UpdateLifetimePayoutMonitoringEstimate(ctx, tx, merchantID, net); err != nil {
			t.Fatalf("update(%d): %v", net, err)
		}
	}
	var got string
	if err := tx.QueryRow(ctx, `SELECT lifetime_net_payout_monitoring_estimate::text FROM merchants WHERE id = $1`, merchantID).Scan(&got); err != nil {
		t.Fatalf("read back: %v", err)
	}
	if got != "100004704" {
		t.Fatalf("lifetime estimate = %s, want exactly 100004704", got)
	}
}
