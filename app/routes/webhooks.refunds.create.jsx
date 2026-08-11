import { authenticate } from "../shopify.server";
import { recalculateCommissionForOrder } from "../services/refunds.server";

/**
 * refunds/create — a refund was issued, so the creator's entitlement changed.
 *
 * The payload's refund lines are deliberately *not* used to compute the new
 * figure. Instead the order is re-read and repriced through the same engine that
 * created the commission, because only that keeps per-product rules correct: a
 * refund of a 20% product must not reduce a mixed order's commission by a flat
 * proportion. The refund id is passed through purely for idempotency.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  // The CLI triggers webhooks with a shop that doesn't exist, so there is no
  // admin client to re-read the order with.
  if (!admin) {
    console.log(`[${topic}] ${shop} skipped — no admin context (CLI-triggered?)`);
    return new Response();
  }

  const orderId =
    payload?.order_id != null ? `gid://shopify/Order/${payload.order_id}` : null;

  try {
    const result = await recalculateCommissionForOrder({
      shop,
      admin,
      orderId,
      sourceId: payload?.id != null ? `refund-${payload.id}` : null,
      reason: `Refund on order ${payload?.order_id ?? ""}`.trim(),
    });

    console.log(
      `[${topic}] ${shop} order=${result.orderNumber ?? orderId} -> ${result.status}` +
        (result.delta !== undefined
          ? ` (${result.previousEntitlement} → ${result.entitled}, delta ${result.delta})`
          : ""),
    );
  } catch (error) {
    // 500 asks Shopify to redeliver; the ledger's unique (commissionId, sourceId)
    // makes that safe.
    console.error(`[${topic}] ${shop} refund recalculation failed`, error);
    return new Response("refund recalculation failed", { status: 500 });
  }

  return new Response();
};
