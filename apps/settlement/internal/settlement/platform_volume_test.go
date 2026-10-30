package settlement

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// resetPlatformStats puts the single counter row back at zero, mirroring
// what db/seed/generate.ts's own TRUNCATE + re-INSERT does on every seed.
func resetPlatformStats(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(), `
		UPDATE platform_stats SET total_processed_fils = 0, updated_at = now() WHERE id = 1
	`)
	if err != nil {
		t.Fatalf("resetPlatformStats: %v", err)
	}
}

// TestRecordPlatformProcessedVolume_SmallValuesExact proves the
// accumulator is wired correctly: three successive batch closes land on
// the exact integer sum of their gross figures.
func TestRecordPlatformProcessedVolume_SmallValuesExact(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	resetPlatformStats(t, pool)

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	for _, gross := range []int64{1_000_000, 2_500_000, 47_500_000} {
		current, err := ReadAndLockPlatformProcessedFils(ctx, tx)
		if err != nil {
			t.Fatalf("ReadAndLockPlatformProcessedFils: %v", err)
		}
		if err := RecordPlatformProcessedVolume(ctx, tx, current, gross); err != nil {
			t.Fatalf("RecordPlatformProcessedVolume(%d): %v", gross, err)
		}
	}

	var got int32
	err = tx.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&got)
	if err != nil {
		t.Fatalf("read back total: %v", err)
	}
	if got != 51_000_000 {
		t.Fatalf("total_processed_fils = %v, want exactly 51000000 (1000000 + 2500000 + 47500000)", got)
	}
}

// TestVolumeTierMdrBonusBps_BelowAndAtThreshold proves the tier comparison
// is correct on both sides of the threshold.
// MK: no test above the threshold, or near int32 max. TODO
func TestVolumeTierMdrBonusBps_BelowAndAtThreshold(t *testing.T) {
	if got := VolumeTierMdrBonusBps(0); got != 0 {
		t.Errorf("zero volume: got %d, want 0", got)
	}
	if got := VolumeTierMdrBonusBps(1_999_999_999); got != 0 {
		t.Errorf("just below threshold: got %d, want 0", got)
	}
	if got := VolumeTierMdrBonusBps(2_000_000_000); got != 15 {
		t.Errorf("exactly at threshold: got %d, want 15", got)
	}
}

// The platform-wide counter has to hold more than int32's 2,147,483,647 fils (2.1M BD):
// the volume-tier threshold is already 2,000,000,000, so the counter is meant to cross it.
// With a 32-bit column/variable the next close either fails ("integer out of range", which
// stops settlement for EVERY merchant) or silently wraps negative and drops the tier bonus.
func TestRecordPlatformProcessedVolume_CrossesInt32Max(t *testing.T) {
	pool := mustPool(t)
	ctx := context.Background()
	resetPlatformStats(t, pool)
	// The counter is shared by every settlement test: leave it at zero so no later test
	// is accidentally above the volume-tier threshold (which discounts every fee).
	t.Cleanup(func() { resetPlatformStats(t, pool) })
	if _, err := pool.Exec(ctx, `UPDATE platform_stats SET total_processed_fils = 2147000000 WHERE id = 1`); err != nil {
		t.Fatalf("seed near-max total: %v", err)
	}

	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck

	current, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatalf("ReadAndLockPlatformProcessedFils: %v", err)
	}
	if err := RecordPlatformProcessedVolume(ctx, tx, current, 1_000_000_000); err != nil {
		t.Fatalf("RecordPlatformProcessedVolume past 2^31: %v", err)
	}

	var got int64
	if err := tx.QueryRow(ctx, `SELECT total_processed_fils FROM platform_stats WHERE id = 1`).Scan(&got); err != nil {
		t.Fatalf("read back total: %v", err)
	}
	if got != 3_147_000_000 {
		t.Fatalf("total_processed_fils = %d, want 3147000000", got)
	}
	next, err := ReadAndLockPlatformProcessedFils(ctx, tx)
	if err != nil {
		t.Fatalf("re-read: %v", err)
	}
	if VolumeTierMdrBonusBps(next) != 15 {
		t.Fatalf("tier bonus after crossing 2^31 = %d bps, want 15 (a wrapped-negative total would give 0)", VolumeTierMdrBonusBps(next))
	}
}
