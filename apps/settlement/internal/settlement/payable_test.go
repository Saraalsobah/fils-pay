package settlement

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

// The net payout is plain integer subtraction. It used to go through float32,
// which cannot hold integers above 2^24 (16,777,216 fils = 16,777 BD)
// exactly, so a large batch's payout could be off by a few fils.
func TestNetPayableFils_IsExactIntegerSubtraction(t *testing.T) {
	cases := []struct {
		name       string
		gross, fee money.Fils
		want       money.Fils
	}{
		{"zero", 0, 0, 0},
		{"small", 1_000, 25, 975},
		{"fee equals gross", 5, 5, 0},
		{"just above 2^24", 16_777_217, 0, 16_777_217},
		{"above 2^25 odd", 33_554_433, 0, 33_554_433},
		{"large with fee", 100_000_001, 1, 100_000_000},
		{"realistic large batch", 123_456_789, 3_086_419, 120_370_370},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := NetPayableFils(tc.gross, tc.fee); got != tc.want {
				t.Errorf("NetPayableFils(%d, %d) = %d, want %d", tc.gross, tc.fee, got, tc.want)
			}
		})
	}
}
