package splits

import (
	"testing"

	"github.com/filspay/settlement/internal/money"
)

func TestChildShares_SumToNet(t *testing.T) {
	cases := []struct {
		name       string
		netPayout  money.Fils
		weightsBps []int64
	}{
		{"two equal", 10000, []int64{5000, 5000}},
		{"three round", 9000, []int64{3000, 3000, 4000}},
		{"single child", 5000, []int64{10000}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			children := make([]ChildWeight, len(tc.weightsBps))
			for i, w := range tc.weightsBps {
				children[i] = ChildWeight{WeightBps: w}
			}
			shares := ChildShares(tc.netPayout, children)
			var total money.Fils
			for _, s := range shares {
				total += s
			}
			if total != tc.netPayout {
				t.Errorf("sum of shares %d != net payout %d", total, tc.netPayout)
			}
		})
	}
}

// Regression test for the "splits always a few fils short" bug: rounding each
// child's share on its own loses (or invents) fils whenever the net payout does
// not divide evenly by the weights. Shares must ALWAYS add up to the net payout.
func TestChildShares_UnevenAmountsStillSumToNet(t *testing.T) {
	cases := []struct {
		name       string
		netPayout  money.Fils
		weightsBps []int64
	}{
		{"1 fil over three equal thirds", 1, []int64{3333, 3333, 3334}},
		{"100 fils, three thirds", 100, []int64{3333, 3333, 3334}},
		{"10 fils, three thirds", 10, []int64{3333, 3333, 3334}},
		{"odd amount, even split", 101, []int64{5000, 5000}},
		{"7 fils, four quarters", 7, []int64{2500, 2500, 2500, 2500}},
		{"realistic 3-way", 123457, []int64{3333, 3333, 3334}},
		{"lopsided weights", 99999, []int64{1, 9999}},
		{"many children", 1003, []int64{1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000, 1000}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			children := make([]ChildWeight, len(tc.weightsBps))
			for i, w := range tc.weightsBps {
				children[i] = ChildWeight{WeightBps: w}
			}
			shares := ChildShares(tc.netPayout, children)
			var total money.Fils
			for _, s := range shares {
				if s < 0 {
					t.Errorf("negative share %d", s)
				}
				total += s
			}
			if total != tc.netPayout {
				t.Errorf("sum of shares %d != net payout %d (shares %v)", total, tc.netPayout, shares)
			}
		})
	}
}

func TestChildShares_Deterministic(t *testing.T) {
	children := []ChildWeight{{3333}, {3333}, {3334}}
	a := ChildShares(100, children)
	b := ChildShares(100, children)
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("not deterministic: %v vs %v", a, b)
		}
	}
}

func TestValidateWeights(t *testing.T) {
	if err := ValidateWeights([]ChildWeight{{5000}, {5000}}); err != nil {
		t.Errorf("10000 total should be valid: %v", err)
	}
	if err := ValidateWeights([]ChildWeight{{5000}, {4000}}); err == nil {
		t.Error("9000 total should be rejected")
	}
	if err := ValidateWeights([]ChildWeight{{6000}, {6000}}); err == nil {
		t.Error("12000 total should be rejected")
	}
	if err := ValidateWeights(nil); err == nil {
		t.Error("no children should be rejected")
	}
}
