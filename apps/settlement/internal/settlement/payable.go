package settlement

import "github.com/filspay/settlement/internal/money"

// NetPayableFils derives the net payout from frozen gross and fee totals.
//
// Integer subtraction, nothing else. This used to convert to float32 BD and
// back, which cannot represent integers above 2^24 exactly (16,777 BD), so a
// large batch paid out a few fils too little or too much.
func NetPayableFils(grossFils, feeFils money.Fils) money.Fils {
	return grossFils - feeFils
}
