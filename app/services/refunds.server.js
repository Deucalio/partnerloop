import prisma from "../db.server";
import { calculateOrderCommission } from "./commission.server";

/**
 * Keeping commissions honest when an order changes after attribution.
 *
 * The guiding rule is that **nothing is overwritten**. A commission's original
 * figure stays put and every change lands in an append-only ledger, so the app
 * can always explain how Rs 78 became Rs 52 rather than just showing a smaller
 * number than the merchant remembers approving.
 *
 * Entitlement is never derived by scaling the old commission down. It is
 * recomputed from the order's *current* line items through the same engine that
 * priced it originally — which is the only way per-product overrides survive a
 * partial refund. Refunding a 20% product out of an order that also contains a
 * 13% product must not reduce the commission by a flat proportion.
 */

const ORDER_STATE_QUERY = `#graphql
  query RefundOrderState($id: ID!) {
    order(id: $id) {
      id
      name
      cancelledAt
      taxesIncluded
      currentSubtotalPriceSet { shopMoney { amount } }
      subtotalPriceSet { shopMoney { amount } }
      customer { numberOfOrders }
      lineItems(first: 250) {
        nodes {
          quantity
          currentQuantity
          product { id }
          originalUnitPriceSet { shopMoney { amount } }
          totalDiscountSet { shopMoney { amount } }
          taxLines { priceSet { shopMoney { amount } } }
        }
      }
    }
  }`;

/** Reshape a GraphQL order into the REST-ish form the engine expects. */
function normalizeOrder(node) {
  return {
    admin_graphql_api_id: node.id,
    name: node.name,
    taxes_included: node.taxesIncluded,
    current_subtotal_price: node.currentSubtotalPriceSet?.shopMoney?.amount,
    subtotal_price: node.subtotalPriceSet?.shopMoney?.amount,
    customer: node.customer ? { orders_count: node.customer.numberOfOrders } : null,
    line_items: (node.lineItems?.nodes ?? []).map((item) => ({
      // currentQuantity is what Shopify reduces when items are refunded, and it
      // is what makes the recomputation line-item accurate.
      quantity: item.quantity,
      current_quantity: item.currentQuantity,
      product_id: item.product?.id,
      price: item.originalUnitPriceSet?.shopMoney?.amount,
      total_discount: item.totalDiscountSet?.shopMoney?.amount,
      tax_lines: (item.taxLines ?? []).map((line) => ({
        price: line?.priceSet?.shopMoney?.amount,
      })),
    })),
  };
}

const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Apply a change to the order behind a commission.
 *
 * @param cancelled  when true, entitlement drops to zero without consulting the
 *                   order — a cancelled order earns nothing regardless of what
 *                   its line items still say.
 * @param sourceId   the Shopify refund/order id; makes redelivery a no-op.
 */
export async function recalculateCommissionForOrder({
  shop,
  admin,
  orderId,
  sourceId,
  reason,
  cancelled = false,
}) {
  if (!orderId) return { status: "invalid_order" };

  const referral = await prisma.referral.findUnique({
    where: { orderId },
    select: {
      id: true,
      orderNumber: true,
      commission: {
        select: {
          id: true,
          amount: true,
          originalAmount: true,
          status: true,
          payoutId: true,
          creator: {
            select: {
              id: true,
              program: {
                select: {
                  shopId: true,
                  commissionConfig: true,
                  productRules: true,
                  customerRules: true,
                },
              },
            },
          },
          adjustments: { select: { amount: true, sourceId: true } },
        },
      },
    },
  });

  // An order we never attributed has no commission to revise. Ordinary, not an
  // error — most orders on a store are not referred.
  if (!referral?.commission) return { status: "not_attributed" };

  const commission = referral.commission;
  if (commission.creator.program.shopId !== shop) return { status: "wrong_shop" };

  // Idempotency: this exact refund has already been accounted for.
  if (sourceId && commission.adjustments.some((a) => a.sourceId === sourceId)) {
    return { status: "already_applied" };
  }

  // What the creator is entitled to *now*.
  let entitled = 0;
  if (!cancelled) {
    const response = await admin.graphql(ORDER_STATE_QUERY, { variables: { id: orderId } });
    const payload = await response.json();
    const node = payload?.data?.order;

    if (!node) return { status: "order_unavailable" };

    // A cancelled order can also arrive through the refund path.
    entitled = node.cancelledAt
      ? 0
      : calculateOrderCommission({
          config: commission.creator.program.commissionConfig,
          productRules: commission.creator.program.productRules,
          customerRules: commission.creator.program.customerRules,
          order: normalizeOrder(node),
        });
  }

  // Compare against the entitlement as it stands after previous adjustments, so
  // several refunds on one order each record only their own delta.
  const baseline = commission.originalAmount ?? commission.amount;
  const adjustedSoFar = commission.adjustments.reduce((sum, a) => sum + a.amount, 0);
  const previousEntitlement = round2(baseline + adjustedSoFar);
  const delta = round2(entitled - previousEntitlement);

  if (delta === 0) {
    return { status: "no_change", entitled, orderNumber: referral.orderNumber };
  }

  const paid = commission.status === "PAID";

  await prisma.$transaction(async (tx) => {
    await tx.commissionAdjustment.create({
      data: {
        commissionId: commission.id,
        amount: delta,
        reason,
        sourceId: sourceId ?? null,
      },
    });

    // Money already sent cannot be un-sent. `amount` stays at what was actually
    // paid and the shortfall becomes a balance the creator owes back, settled
    // against a future payout rather than clawed out of their account.
    if (paid) return;

    await tx.commission.update({
      where: { id: commission.id },
      data: {
        amount: Math.max(0, entitled),
        ...(entitled <= 0
          ? { status: "REJECTED", rejectedAt: new Date(), rejectionReason: reason }
          : {}),
      },
    });
  });

  return {
    status: paid ? "recorded_as_debt" : "adjusted",
    orderNumber: referral.orderNumber,
    previousEntitlement,
    entitled,
    delta,
    commissionId: commission.id,
  };
}

/**
 * What a creator has been overpaid, from adjustments against commissions that
 * were already paid out.
 *
 * Derived rather than stored: it is a view of the ledger, and a stored copy
 * would be one more thing that can disagree with it.
 */
export async function getCreatorBalances(shop) {
  const adjustments = await prisma.commissionAdjustment.findMany({
    where: {
      commission: { status: "PAID", creator: { program: { shopId: shop } } },
    },
    select: { amount: true, commission: { select: { creatorId: true } } },
  });

  const balances = new Map();
  for (const adjustment of adjustments) {
    const creatorId = adjustment.commission.creatorId;
    balances.set(creatorId, round2((balances.get(creatorId) ?? 0) - adjustment.amount));
  }

  // Only positive balances are debts worth showing.
  return Object.fromEntries([...balances].filter(([, owed]) => owed > 0));
}
