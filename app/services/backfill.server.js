import { attributeOrder } from "./attribution.server";

/**
 * Attribute orders that already existed before tracking was switched on.
 *
 * Shopify only fires orders/create for new orders, so anything placed before the
 * webhook was subscribed is invisible to it. This reads those orders back through
 * the Admin API and runs them through exactly the same attribution path, which
 * keeps one definition of "attributed" rather than two that can drift.
 */

const ORDERS_QUERY = `#graphql
  query BackfillOrders($first: Int!, $query: String) {
    orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        customAttributes { key value }
        currentSubtotalPriceSet { shopMoney { amount } }
        subtotalPriceSet { shopMoney { amount } }
        # Tax-inclusive stores report a subtotal that already contains tax.
        taxesIncluded
        # Drives the new-vs-returning customer rule.
        customer { numberOfOrders }
        lineItems(first: 250) {
          nodes {
            quantity
            currentQuantity
            # Carries the code for orders placed through a dynamic checkout
            # button, which never creates a cart to attach an attribute to.
            customAttributes { key value }
            taxLines { priceSet { shopMoney { amount } } }
            # Needed to apply per-product commission rules line by line.
            product { id }
            originalUnitPriceSet { shopMoney { amount } }
            totalDiscountSet { shopMoney { amount } }
          }
        }
      }
    }
  }`;

/**
 * Reshape a GraphQL order into the REST-ish form the webhook delivers, so
 * attributeOrder sees an identical payload from either source.
 */
function normalizeOrder(node) {
  return {
    admin_graphql_api_id: node.id,
    name: node.name,
    // readReferralCode accepts key/value as well as name/value.
    note_attributes: node.customAttributes,
    current_subtotal_price: node.currentSubtotalPriceSet?.shopMoney?.amount,
    subtotal_price: node.subtotalPriceSet?.shopMoney?.amount,
    taxes_included: node.taxesIncluded,
    // customerTypeOf accepts either spelling.
    customer: node.customer ? { orders_count: node.customer.numberOfOrders } : null,
    line_items: (node.lineItems?.nodes ?? []).map((item) => ({
      quantity: item.quantity,
      current_quantity: item.currentQuantity,
      // readReferralCode accepts key/value here too.
      properties: item.customAttributes,
      tax_lines: (item.taxLines ?? []).map((line) => ({
        price: line?.priceSet?.shopMoney?.amount,
      })),
      product_id: item.product?.id,
      price: item.originalUnitPriceSet?.shopMoney?.amount,
      total_discount: item.totalDiscountSet?.shopMoney?.amount,
    })),
  };
}

/**
 * @param admin  an object with a `graphql(query, options)` method
 * @param shop   the myshopify domain, used for the tenancy check
 * @param query  optional Shopify order search filter, e.g. `name:#1759`
 */
export async function backfillOrders(admin, { shop, first = 25, query = null }) {
  const response = await admin.graphql(ORDERS_QUERY, {
    variables: { first, query },
  });

  const payload = await response.json();

  if (payload.errors) {
    throw new Error(`Backfill query failed: ${JSON.stringify(payload.errors).slice(0, 300)}`);
  }

  const results = [];
  for (const node of payload?.data?.orders?.nodes ?? []) {
    const result = await attributeOrder({ shop, order: normalizeOrder(node) });
    results.push({ order: node.name, ...result });
  }

  return results;
}
