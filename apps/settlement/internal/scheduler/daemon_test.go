package scheduler

import (
	"testing"
	"time"
)

// The close must start shortly after Asia/Bahrain midnight (UTC+3), for the Bahrain
// day that just ended. Bahrain 00:15 on 25 Mar is 21:15 UTC on 24 Mar: the UTC
// calendar date is still the 24th, which is what the old code used.
func TestDueBusinessDate(t *testing.T) {
	cases := []struct {
		name     string
		now      time.Time
		wantDue  bool
		wantDate string
	}{
		{"23:50 Bahrain on the 24th: re-checks the 23rd (already closed, idempotent no-op)", time.Date(2026, 3, 24, 20, 50, 0, 0, time.UTC), true, "2026-03-23"},
		{"00:10 Bahrain, inside the 15 min grace period", time.Date(2026, 3, 24, 21, 10, 0, 0, time.UTC), false, ""},
		{"00:15 Bahrain, due: closes the 24th (not the 23rd)", time.Date(2026, 3, 24, 21, 15, 0, 0, time.UTC), true, "2026-03-24"},
		{"02:59 Bahrain, still the 24th", time.Date(2026, 3, 24, 23, 59, 0, 0, time.UTC), true, "2026-03-24"},
		{"03:00 Bahrain, same answer once the UTC date flips", time.Date(2026, 3, 25, 0, 0, 0, 0, time.UTC), true, "2026-03-24"},
		{"noon Bahrain", time.Date(2026, 3, 25, 9, 0, 0, 0, time.UTC), true, "2026-03-24"},
	}
	for _, c := range cases {
		date, due := dueBusinessDate(c.now, 15)
		if due != c.wantDue {
			t.Errorf("%s: due = %v, want %v", c.name, due, c.wantDue)
			continue
		}
		if due && date.Format("2006-01-02") != c.wantDate {
			t.Errorf("%s: business date = %s, want %s", c.name, date.Format("2006-01-02"), c.wantDate)
		}
	}
}
