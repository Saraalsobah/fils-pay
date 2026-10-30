import { useRef, useState } from "react";
import { ApiError, describeError } from "../../api/client.js";
import { refundTransaction } from "../../api/transactions.js";
import { RequireRole } from "../../auth/RequireRole.js";
import { bhd } from "../../format.js";
import type { TransactionDto } from "../../types.js";

interface RefundDrawerProps {
  txn: TransactionDto;
  onRefunded: () => Promise<void>;
}

/**
 * Refund control for the transaction detail page. Posts to `POST /v1/refunds`
 * (the merchant is taken from the session server-side, not from the URL).
 *
 * Idempotency: one key is reused for the SAME refund attempt, so a retry
 * after a dropped connection can never refund twice. A new key is made when
 * the amount changes, after success, and after a definite answer from the
 * server (a decline, a validation error) so the merchant can try again.
 */
export function RefundDrawer({ txn, onRefunded }: RefundDrawerProps) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  const refundableFils = Math.max(0, txn.capturedFils - txn.refundedFils);
  const refundable =
    (txn.status === "captured" || txn.status === "partially_captured" || txn.status === "partially_refunded") &&
    refundableFils > 0;

  async function handleRefund(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = amount.trim();
    if (trimmed !== "" && (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0)) {
      setError("Enter a whole number of fils greater than zero.");
      return;
    }
    if (trimmed !== "" && Number(trimmed) > refundableFils) {
      setError(`You can refund at most ${bhd(refundableFils)}.`);
      return;
    }
    const what = trimmed === "" ? bhd(refundableFils) : bhd(Number(trimmed));
    if (!window.confirm(`Refund ${what}? The money goes back to the cardholder and cannot be recalled.`)) {
      return;
    }

    const signature = `${txn.id}|${trimmed}`;
    if (!attempt.current || attempt.current.signature !== signature) {
      attempt.current = { signature, key: crypto.randomUUID() };
    }
    const idempotencyKey = attempt.current.key;

    setSubmitting(true);
    setError(null);
    try {
      // Left blank, amountFils is omitted and the API refunds everything
      // still refundable -- its own documented default.
      await refundTransaction(
        trimmed === "" ? { transactionId: txn.id } : { transactionId: txn.id, amountFils: Number(trimmed) },
        idempotencyKey,
      );
      attempt.current = null;
      setOpen(false);
      setAmount("");
      // Refetch rather than patch: the refund wrote a new timeline event.
      await onRefunded();
    } catch (err) {
      // A definite answer (4xx) ends this attempt; a network error or 5xx
      // keeps the key so the retry is recognised as the same refund.
      if (err instanceof ApiError && err.statusCode < 500) {
        attempt.current = null;
      }
      setError(describeError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (!refundable) return null;

  return (
    <RequireRole allow={["owner", "finance"]}>
      <div className="dash-actions">
        {error ? <p className="dash-error">{error}</p> : null}
        {open ? (
          <form className="dash-form dash-form-inline" onSubmit={(e) => void handleRefund(e)}>
            <label>
              Amount in fils (blank refunds everything still refundable)
              <input
                type="number"
                min={1}
                step={1}
                max={refundableFils}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </label>
            <p className="dash-muted">Still refundable: {bhd(refundableFils)}</p>
            <button type="submit" className="dash-button" disabled={submitting}>
              {submitting ? "Refunding..." : "Refund"}
            </button>
            <button type="button" className="dash-button" disabled={submitting} onClick={() => setOpen(false)}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" className="dash-button" onClick={() => setOpen(true)}>
            Refund
          </button>
        )}
      </div>
    </RequireRole>
  );
}
