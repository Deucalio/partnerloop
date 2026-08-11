import prisma from "../db.server";
import { REF_ATTRIBUTE } from "./tracking.server";
import {
  calculateOrderCommission,
  qualifyingItemCount,
  qualifyingSubtotal,
} from "./commission.server";

/**
 * Turning a Shopify order into a Referral + Commission.
 *
 * The commission written here is a starting value, not a final one. Refunds,
 * cancellations and order edits all revise it later, which is why the amount is
 * derived by a pure function (see commission.server.js) and stored alongside the
 * qualifying subtotal it was computed from.
 */

/** Find `_pl_ref` in a list of attributes, whichever spelling they use. */
function findRef(attributes) {
  if (!Array.isArray(attributes)) return null;

  const match = attributes.find((attribute) => {
    const label = attribute?.name ?? attribute?.key;
    return label === REF_ATTRIBUTE;
  });

  const value = typeof match?.value === "string" ? match.value.trim() : "";
  return value || null;
}

/**
 * Read the referral code off an order, from either place the storefront can put
 * it.
 *
 * **Order attributes** are set when the shopper goes through the cart.
 * **Line item properties** cover the other route: dynamic checkout buttons
 * ("Buy it now", Shop Pay) submit the product form straight to checkout without
 * ever creating a cart, so no cart attribute exists. Order #1760 was lost to
 * exactly that before the form-stamping was added.
 *
 * Both spellings are handled throughout: the orders/create webhook payload is
 * REST-shaped (`note_attributes` / `properties`, keyed by `name`), while the
 * GraphQL Admin API used by the backfill returns `customAttributes` keyed by
 * `key`.
 */
export function readReferralCode(order) {
  const fromOrder = findRef(order?.note_attributes ?? order?.customAttributes);
  if (fromOrder) return fromOrder;

  const lineItems = order?.line_items ?? order?.lineItems?.nodes ?? [];
  if (!Array.isArray(lineItems)) return null;

  for (const lineItem of lineItems) {
    const fromLine = findRef(lineItem?.properties ?? lineItem?.customAttributes);
    if (fromLine) return fromLine;
  }

  return null;
}

/**
 * When a commission becomes safe to approve, given the program's hold period.
 * Null when the program sets no hold — the commission is eligible immediately.
 */
function holdUntil(holdDays) {
  if (!Number.isFinite(holdDays) || holdDays <= 0) return null;
  return new Date(Date.now() + holdDays * 86400000);
}

/** Prefer the GID; fall back to the numeric id for REST-shaped payloads. */
function orderIdentity(order) {
  const id = order?.admin_graphql_api_id ?? (order?.id != null ? String(order.id) : null);
  const number = order?.name ?? (order?.order_number != null ? `#${order.order_number}` : null);
  return { id, number };
}

/**
 * Attribute one order.
 *
 * Idempotent by design, and in two layers. The explicit lookup below is the
 * normal path — Shopify delivers webhooks at-least-once, and a redelivery must
 * be a no-op rather than a second payout. The unique index on `Referral.orderId`
 * is the backstop for the case the lookup cannot cover: two deliveries racing
 * each other, where both read "not found" before either writes.
 *
 * Returns a status rather than throwing, so the webhook can ACK every outcome
 * that isn't an infrastructure failure — an order with no referral code is
 * completely ordinary and must not look like an error to Shopify.
 */
export async function attributeOrder({ shop, order }) {
  const { id: orderId, number: orderNumber } = orderIdentity(order);

  if (!orderId) {
    return { status: "invalid_order" };
  }

  // 1. Has this order already been attributed?
  const existing = await prisma.referral.findUnique({
    where: { orderId },
    select: { id: true, creatorId: true },
  });

  if (existing) {
    return { status: "already_attributed", referralId: existing.id };
  }

  // 2. Does it carry a referral code?
  const referralCode = readReferralCode(order);
  if (!referralCode) {
    return { status: "no_referral_code" };
  }

  // 3. Does that code belong to an active creator on *this* shop?
  const creator = await prisma.creator.findUnique({
    where: { referralCode },
    select: {
      id: true,
      status: true,
      program: {
        select: {
          shopId: true,
          status: true,
          commissionConfig: true,
          productRules: true,
          customerRules: true,
        },
      },
    },
  });

  if (!creator || creator.program.shopId !== shop) {
    return { status: "unknown_code", referralCode };
  }

  if (creator.status !== "ACTIVE" || creator.program.status !== "ACTIVE") {
    return { status: "inactive", referralCode };
  }

  // 4. What is it worth? Precedence: product override → customer-type rule →
  //    program default, with the minimum-order-value gate above all three.
  const subtotal = qualifyingSubtotal(order);
  const itemCount = qualifyingItemCount(order);
  const amount = calculateOrderCommission({
    config: creator.program.commissionConfig,
    productRules: creator.program.productRules,
    customerRules: creator.program.customerRules,
    order,
  });

  // 5. Write both records or neither. A referral without its commission would
  //    show the merchant attributed revenue that nobody is ever paid for.
  try {
    const referral = await prisma.$transaction(async (tx) => {
      const created = await tx.referral.create({
        data: {
          creatorId: creator.id,
          orderId,
          orderNumber,
          orderAmount: subtotal,
          // The order exists, so the referral is real. The *commission* is what
          // still waits on the merchant before it can be paid.
          status: "APPROVED",
        },
      });

      await tx.commission.create({
        data: {
          creatorId: creator.id,
          referralId: created.id,
          amount,
          status: "PENDING",
          // Stamped now rather than computed on read, so changing a program's
          // hold period never retroactively moves money that was already
          // promised under the old terms.
          eligibleAt: holdUntil(creator.program.commissionConfig?.holdDays),
        },
      });

      return created;
    });

    return {
      status: "attributed",
      referralId: referral.id,
      creatorId: creator.id,
      referralCode,
      subtotal,
      itemCount,
      amount,
    };
  } catch (error) {
    // P2002 here means a concurrent delivery won the race between our lookup
    // and this write. That is the desired outcome, not a failure.
    if (error?.code === "P2002") {
      return { status: "already_attributed" };
    }
    throw error;
  }
}
