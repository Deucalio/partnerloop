/**
 * Commission maths.
 *
 * Deliberately pure and free of database access: a commission is **not**
 * immutable. Refunds, cancellations and order edits all need the amount
 * recomputed from new figures, so the calculation has to be callable again with
 * a different subtotal or item count rather than only at order-creation time.
 * Keeping it side-effect free is what makes that possible.
 */

/** Commission is paid on what the merchant actually sold. */
export const COMMISSION_BASIS =
  "Order subtotal after discounts, excluding tax and shipping";

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/**
 * @param config  the program's CommissionConfig, or null
 * @param basis   { subtotal, itemCount } — the qualifying figures for the order
 * @returns the commission amount, rounded to 2dp
 *
 * Note there is intentionally no cap at the subtotal. A `FIXED_PER_ORDER` rule
 * larger than a small order really does owe more than the sale was worth; that
 * is the merchant's configured rule, and silently clamping it would hide a
 * misconfiguration rather than surface it. Minimum-order-value guards belong
 * with the rest of the rule engine.
 */
export function calculateCommission(config, { subtotal = 0, itemCount = 0 } = {}) {
  if (!config) return 0;

  switch (config.type) {
    case "PERCENTAGE":
      return round2(subtotal * (config.amount / 100));
    case "FIXED_PER_ORDER":
      return round2(config.amount);
    case "FIXED_PER_ITEM":
      return round2(config.amount * itemCount);
    default:
      return 0;
  }
}

/** Tax charged on the goods themselves, ignoring any tax on shipping. */
function lineItemTax(order) {
  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];

  return lineItems.reduce((total, item) => {
    const taxLines = Array.isArray(item?.tax_lines) ? item.tax_lines : [];
    return (
      total +
      taxLines.reduce((sum, line) => {
        const price = Number.parseFloat(line?.price);
        return sum + (Number.isFinite(price) ? price : 0);
      }, 0)
    );
  }, 0);
}

/**
 * The subtotal a commission is calculated on.
 *
 * Prefers `current_*` fields, which Shopify keeps in step with refunds and order
 * edits, falling back to the original figures. That preference is what will let
 * a refund handler re-run this and get a smaller number without any changes here.
 *
 * Stores that display tax-inclusive prices — the norm across the UK, EU and
 * Australia — report a subtotal that *already contains* tax. Left alone, that
 * would quietly pay commission on tax for every such merchant, breaking the
 * stated basis. The tax is subtracted back out using line-item `tax_lines`
 * rather than `total_tax`, because the latter can also include tax on shipping,
 * which was never part of the commissionable amount.
 */
export function qualifyingSubtotal(order) {
  const raw =
    order?.current_subtotal_price ??
    order?.subtotal_price ??
    order?.current_total_price ??
    "0";

  const value = Number.parseFloat(raw);
  const subtotal = Number.isFinite(value) ? value : 0;

  if (order?.taxes_included === true) {
    return round2(Math.max(0, subtotal - lineItemTax(order)));
  }

  return round2(subtotal);
}

/** Item count for per-item rules, likewise refund-aware. */
export function qualifyingItemCount(order) {
  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];

  return lineItems.reduce((total, item) => {
    const quantity = item?.current_quantity ?? item?.quantity ?? 0;
    return total + (Number.isFinite(quantity) ? quantity : 0);
  }, 0);
}

/** Rule types that can be applied to a single line item. */
export const PRODUCT_RULE_TYPES = ["PERCENTAGE", "FIXED_PER_ITEM"];

function lineQuantity(lineItem) {
  const quantity = lineItem?.current_quantity ?? lineItem?.quantity ?? 0;
  return Number.isFinite(quantity) ? quantity : 0;
}

/** Numeric tail of an id, so `gid://shopify/Product/123` and `123` compare equal. */
function normalizeProductId(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.split("/").pop() || null;
}

/**
 * What one line item contributes to the commissionable base.
 *
 * Mirrors `qualifyingSubtotal` at line level: quantity × unit price, less
 * discounts allocated to that line, less its tax on tax-inclusive stores.
 * `discount_allocations` is preferred over `total_discount` because it accounts
 * for order-level discounts spread across lines.
 */
export function qualifyingLineAmount(order, lineItem) {
  const unitPrice = Number.parseFloat(lineItem?.price);
  const gross = (Number.isFinite(unitPrice) ? unitPrice : 0) * lineQuantity(lineItem);

  const allocations = Array.isArray(lineItem?.discount_allocations)
    ? lineItem.discount_allocations
    : [];

  const discount = allocations.length
    ? allocations.reduce((sum, allocation) => {
        const amount = Number.parseFloat(allocation?.amount);
        return sum + (Number.isFinite(amount) ? amount : 0);
      }, 0)
    : Number.parseFloat(lineItem?.total_discount) || 0;

  let net = gross - discount;

  if (order?.taxes_included === true) {
    const taxLines = Array.isArray(lineItem?.tax_lines) ? lineItem.tax_lines : [];
    net -= taxLines.reduce((sum, line) => {
      const price = Number.parseFloat(line?.price);
      return sum + (Number.isFinite(price) ? price : 0);
    }, 0);
  }

  return round2(Math.max(0, net));
}

/** Commission for a single line under a product-level rule. */
function lineCommission(rule, amount, quantity) {
  switch (rule.type) {
    case "PERCENTAGE":
      return amount * (rule.amount / 100);
    case "FIXED_PER_ITEM":
      return rule.amount * quantity;
    default:
      // FIXED_PER_ORDER is rejected for product rules; treat as no override.
      return 0;
  }
}

/**
 * Whether this order's buyer is new or returning, or null when we can't tell.
 *
 * `orders_count` on the webhook payload includes the order being placed, so a
 * first-time buyer arrives as 1, not 0. A guest checkout carries no customer at
 * all — that returns null so the caller falls through to the program default
 * rather than guessing, since guessing "new" would quietly pay the higher
 * acquisition rate to anyone who declines to make an account.
 */
export function customerTypeOf(order) {
  const count = order?.customer?.orders_count ?? order?.customer?.numberOfOrders;
  const parsed = typeof count === "string" ? Number.parseInt(count, 10) : count;

  if (!Number.isFinite(parsed)) return null;
  return parsed <= 1 ? "NEW" : "RETURNING";
}

/**
 * Resolve which rule stands in for the program default on this order.
 *
 * This is the middle step of the precedence chain: a customer-type rule replaces
 * the default wholesale, so it accepts the same three rule types the default
 * does — including FIXED_PER_ORDER, which is meaningful here because a customer
 * is an order-level fact, unlike a product.
 */
function resolveBaseRule({ config, customerRules = [], order }) {
  const customerType = customerTypeOf(order);
  if (!customerType) return config;

  const match = (customerRules ?? []).find((rule) => rule?.customerType === customerType);
  return match ?? config;
}

/**
 * Commission for a whole order.
 *
 * **Precedence, highest first:**
 *
 * 1. **Product override** — a line whose product has a rule earns under it.
 * 2. **Customer-type rule** — new vs returning, applied to everything a product
 *    rule did not claim.
 * 3. **Program default** — the fallback when neither of the above applies.
 *
 * A **minimum order value** sits above all three: it is a gate, not a rule. An
 * order below it earns nothing regardless of how generous the matching rules are.
 *
 * Within step 2/3, whichever rule wins covers only the lines no product rule
 * claimed: a percentage over their combined amount, a per-item rate over their
 * combined quantity, or — for `FIXED_PER_ORDER` — the flat amount **once**, and
 * only if at least one line actually fell back.
 *
 * With no product rules at all, this delegates to the whole-order path so results
 * stay byte-identical to the simpler behaviour. That matters: summing line
 * amounts can drift by a rounding cent from Shopify's own `subtotal_price`, and
 * the common case should never inherit that drift.
 */
export function calculateOrderCommission({
  config,
  productRules = [],
  customerRules = [],
  order,
} = {}) {
  const subtotal = qualifyingSubtotal(order);

  // Gate: below the minimum, nothing is earned at all.
  const minimum = config?.minimumOrderValue;
  if (Number.isFinite(minimum) && minimum > 0 && subtotal < minimum) {
    return 0;
  }

  const baseRule = resolveBaseRule({ config, customerRules, order });

  const applicable = (productRules ?? []).filter((rule) =>
    PRODUCT_RULE_TYPES.includes(rule?.type),
  );

  if (applicable.length === 0) {
    return calculateCommission(baseRule, {
      subtotal,
      itemCount: qualifyingItemCount(order),
    });
  }

  const byProduct = new Map();
  for (const rule of applicable) {
    const key = normalizeProductId(rule.productId);
    if (key) byProduct.set(key, rule);
  }

  const lineItems = Array.isArray(order?.line_items) ? order.line_items : [];

  let total = 0;
  let fallbackAmount = 0;
  let fallbackQuantity = 0;
  let sawFallback = false;

  for (const lineItem of lineItems) {
    const amount = qualifyingLineAmount(order, lineItem);
    const quantity = lineQuantity(lineItem);
    const rule = byProduct.get(normalizeProductId(lineItem?.product_id));

    if (rule) {
      total += lineCommission(rule, amount, quantity);
    } else {
      sawFallback = true;
      fallbackAmount += amount;
      fallbackQuantity += quantity;
    }
  }

  // Whatever no product rule claimed earns under the customer-type rule if one
  // matched, otherwise the program default.
  if (sawFallback && baseRule) {
    switch (baseRule.type) {
      case "PERCENTAGE":
        total += fallbackAmount * (baseRule.amount / 100);
        break;
      case "FIXED_PER_ITEM":
        total += baseRule.amount * fallbackQuantity;
        break;
      case "FIXED_PER_ORDER":
        total += baseRule.amount;
        break;
      default:
        break;
    }
  }

  return round2(total);
}
