package settlement

import (
	"context"
	"regexp"
	"testing"
	"time"

	"github.com/filspay/settlement/internal/money"
)

var twoDecimalPlaces = regexp.MustCompile(`^\d+\.\d{2}$`)

// TestSchemeExportAmountHasTwoDecimals pins the acquirer-format promise
// scheme_export_lines.amount carries: every line handed to the clearing
// file is quoted in BD at exactly the two decimal places the scheme
// accepts — no third digit, no bare integer, no trailing-zero loss.
// am: 4747 -> "4.75" passes the regex. is 4.75 right for 4747 fils?? it rounds. whatever, scheme wants 2dp
func TestSchemeExportAmountHasTwoDecimals(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 24, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	for i, amount := range []money.Fils{4747, 1005, 4740, 12344} {
		insertCaptureEvent(t, pool, merchantID, mdrBps, amount, start.Add(time.Duration(i+1)*time.Hour))
	}

	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	lines, err := LoadSchemeExportLines(context.Background(), pool, result.BatchID)
	if err != nil {
		t.Fatalf("LoadSchemeExportLines: %v", err)
	}
	if len(lines) != 4 {
		t.Fatalf("expected 4 exported lines, got %d", len(lines))
	}
	for _, line := range lines {
		if !twoDecimalPlaces.MatchString(line.Amount) {
			t.Errorf("line %d amount = %q, want exactly two decimal places", line.LineSequence, line.Amount)
		}
	}
}

// The amount written to the scheme file must be exactly amount_fils / 1000: the same
// truncated figure the ledger-side column holds. It used to be computed from the UNtruncated
// gross as a float and stored into NUMERIC(10,2), which ROUNDS, so 4,747 fils was exported as
// 4.75 while amount_fils said 4,740 (4.74): the file and the batch disagreed by 0.01 BD per line.
func TestSchemeExportAmountAgreesWithAmountFils(t *testing.T) {
	pool := mustPool(t)
	const mdrBps = 250
	merchantID := insertActiveMerchant(t, pool, mdrBps)
	businessDate := time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC)
	start, _ := BusinessDayWindow(businessDate)

	for i, amount := range []money.Fils{4747, 1005, 4749, 12344, 999_999} {
		insertCaptureEvent(t, pool, merchantID, mdrBps, amount, start.Add(time.Duration(i+1)*time.Hour))
	}
	result, err := CloseBatch(context.Background(), pool, merchantID, businessDate)
	if err != nil {
		t.Fatalf("CloseBatch: %v", err)
	}

	rows, err := pool.Query(context.Background(), `
		SELECT amount_fils, amount::text FROM scheme_export_lines WHERE settlement_batch_id = $1 ORDER BY line_sequence
	`, result.BatchID)
	if err != nil {
		t.Fatalf("query lines: %v", err)
	}
	defer rows.Close()
	n := 0
	for rows.Next() {
		var fils int64
		var amount string
		if err := rows.Scan(&fils, &amount); err != nil {
			t.Fatalf("scan: %v", err)
		}
		if want := formatFilsAsTwoDecimalString(money.Fils(fils)); amount != want {
			t.Errorf("line amount = %s but amount_fils = %d (%s): the scheme file disagrees with the batch", amount, fils, want)
		}
		n++
	}
	if n != 5 {
		t.Fatalf("expected 5 lines, got %d", n)
	}
}
