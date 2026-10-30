package splits

import (
	"fmt"
	"sort"

	"github.com/filspay/settlement/internal/money"
)

// TotalWeightBps is what a parent's children's weights must add up to (100%).
const TotalWeightBps int64 = 10_000

// ChildWeight is one sub-merchant's configured share of a parent's payout.
type ChildWeight struct {
	WeightBps int64
}

// ValidateWeights checks that a parent's children's weights add up to exactly
// 10000 bps. The database does not enforce this (see migration 0045), so it
// is checked here, before any money moves.
func ValidateWeights(children []ChildWeight) error {
	if len(children) == 0 {
		return fmt.Errorf("splits: no children configured")
	}
	var sum int64
	for _, c := range children {
		sum += c.WeightBps
	}
	if sum != TotalWeightBps {
		return fmt.Errorf("splits: child weights sum to %d bps, want %d", sum, TotalWeightBps)
	}
	return nil
}

// ChildShares distributes netPayout across children by their weights so that
// the shares ALWAYS add up to exactly netPayout.
//
// Each child first gets the whole-fils part of its share (rounded down). The
// fils left over (always fewer than len(children)) are then handed out one
// each to the children with the largest fractional remainders ("largest
// remainder method"). Ties go to the earlier child, so the result is
// deterministic. Rounding each share on its own (ApplyRateFils per child)
// cannot do this: it silently loses or invents fils whenever the amount does
// not divide evenly.
func ChildShares(netPayout money.Fils, children []ChildWeight) []money.Fils {
	out := make([]money.Fils, len(children))
	if len(children) == 0 || netPayout <= 0 {
		return out
	}

	var totalWeight int64
	for _, c := range children {
		totalWeight += c.WeightBps
	}
	if totalWeight <= 0 {
		return out
	}

	remainders := make([]int64, len(children))
	var allocated int64
	for i, c := range children {
		exact := int64(netPayout) * c.WeightBps // numerator over totalWeight
		out[i] = money.Fils(exact / totalWeight)
		remainders[i] = exact % totalWeight
		allocated += int64(out[i])
	}

	leftover := int64(netPayout) - allocated
	order := make([]int, len(children))
	for i := range order {
		order[i] = i
	}
	sort.SliceStable(order, func(a, b int) bool { return remainders[order[a]] > remainders[order[b]] })
	for k := int64(0); k < leftover; k++ {
		out[order[k]]++
	}
	return out
}
