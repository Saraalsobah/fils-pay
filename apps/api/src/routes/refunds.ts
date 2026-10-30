import type { FastifyInstance, FastifyRequest } from "fastify";
import { toFils } from "@filspay/money";
import {
  requireMerchantAuth,
  requireMerchantRole,
  requireMerchantWriterActor,
} from "../auth/requireMerchantAuth.js";
import { initiateMerchantRefund } from "../refunds/initiateMerchantRefund.js";
import { BadRequestError, ForbiddenError } from "../lib/errors.js";

interface RefundBody {
  transactionId?: unknown;
  amountFils?: unknown;
  reason?: unknown;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON_LENGTH = 500;

/** Refunds are money-moving, so a retry must be recognisable: the caller
 *  supplies the key, we never invent one per request. */
function getIdempotencyKey(request: FastifyRequest): string {
  const header = request.headers["idempotency-key"];
  const key = Array.isArray(header) ? header[0] : header;
  if (!key) {
    throw new BadRequestError("idempotency_key_required", "Idempotency-Key header is required");
  }
  return key;
}

/**
 * `POST /v1/refunds` — full or partial refund of a captured transaction.
 *
 * Body: `{ transactionId, amountFils?, reason? }`. Leaving `amountFils` out
 * refunds everything still refundable. `Idempotency-Key` header required.
 *
 * Who may refund: an API key (owner-issued), or a signed-in `owner` /
 * `finance` user. An admin's "view as merchant" session is never allowed to
 * move money. The merchant is always taken from the authentication, never
 * from the body, so a merchant can only refund its own transactions.
 */
export async function refundRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: RefundBody }>(
    "/",
    { preHandler: [requireMerchantAuth, requireMerchantRole("owner", "finance")] },
    async (request, reply) => {
      const auth = request.merchantAuth!;
      if (auth.actorType === "admin_impersonation") {
        throw new ForbiddenError("forbidden");
      }

      const idempotencyKey = getIdempotencyKey(request);
      const { transactionId, amountFils, reason } = request.body ?? {};

      if (typeof transactionId !== "string" || !UUID_PATTERN.test(transactionId)) {
        throw new BadRequestError("invalid_request", "transactionId must be a transaction id");
      }
      if (amountFils !== undefined && (typeof amountFils !== "number" || !Number.isSafeInteger(amountFils) || amountFils <= 0)) {
        throw new BadRequestError("invalid_request", "amountFils must be a positive whole number of fils");
      }
      if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REASON_LENGTH)) {
        throw new BadRequestError("invalid_request", `reason must be text of at most ${MAX_REASON_LENGTH} characters`);
      }

      const result = await initiateMerchantRefund(app.db, app.acquirer, {
        merchantId: auth.merchantId,
        transactionId,
        amountFils: amountFils === undefined ? undefined : toFils(amountFils),
        idempotencyKey,
        actor: requireMerchantWriterActor(auth),
        reason: reason === undefined || reason === "" ? undefined : reason,
      });
      reply.code(result.statusCode).send(result.body);
    },
  );
}
