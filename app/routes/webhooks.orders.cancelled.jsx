import { authenticate } from "../shopify.server";
import { recalculateCommissionForOrder } from "../services/refunds.server";

/**
 * orders/cancelled — the order is off, so the entitlement drops to zero.
 *
 * Handled without re-reading the order: a cancelled order earns nothing whatever
 * its line items still say, and skipping the fetch means this keeps working even
 * if the Admin API is briefly unavailable.
 *
 * The `Referral` is untouched. "Sarah generated this order" stays true even
 * though "Sarah is owed for it" has become false — collapsing the two would
 * delete her from attribution history.
 */
export const action = async ({ request }) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);

  const orderId =
    payload?.admin_graphql_api_id ??
    (payload?.id != null ? `gid://shopify/Order/${payload.id}` : null);

  try {
    const result = await recalculateCommissionForOrder({
      shop,
      admin,
      orderId,
      cancelled: true,
      sourceId: `cancel-${payload?.id ?? orderId}`,
      reason: "Order cancelled",
    });

    console.log(
      `[${topic}] ${shop} order=${result.orderNumber ?? payload?.name ?? orderId} -> ${result.status}` +
        (result.delta !== undefined ? ` (delta ${result.delta})` : ""),
    );
  } catch (error) {
    console.error(`[${topic}] ${shop} cancellation handling failed`, error);
    return new Response("cancellation handling failed", { status: 500 });
  }

  return new Response();
};
