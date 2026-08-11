import { authenticate } from "../shopify.server";
import { attributeOrder } from "../services/attribution.server";

/**
 * orders/create — attribute a referred order to the creator who earned it.
 *
 * The work runs inline rather than behind a job queue, which is a deliberate
 * departure from the "record a marker, ACK, compute later" pattern in
 * SHOPIFY_APP_PLAYBOOK.md §2. That pattern exists for handlers that fan out
 * across an unbounded amount of data; this one does two indexed lookups and a
 * single small transaction, well inside the 5-second budget.
 *
 * What makes inline safe here is idempotency: if Shopify times out and redelivers,
 * `attributeOrder` finds the existing referral and no-ops, so a retry can never
 * double-pay. Deferring the work would buy nothing and add a queue to operate.
 *
 * Never spawn this as fire-and-forget after returning a response — that silently
 * dies on serverless (playbook §7).
 */
export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  try {
    const result = await attributeOrder({ shop, order: payload });

    // Logged at info level on purpose: when a merchant asks why an order wasn't
    // credited, the reason ("no_referral_code", "inactive", "unknown_code") is
    // the first thing anyone needs.
    console.log(
      `[${topic}] ${shop} order=${payload?.name ?? payload?.id} -> ${result.status}` +
        (result.amount !== undefined ? ` (commission ${result.amount})` : ""),
    );
  } catch (error) {
    // Returning 500 asks Shopify to redeliver, which is what we want for a
    // transient database problem — the retry is safe because attribution is
    // idempotent.
    console.error(`[${topic}] ${shop} attribution failed`, error);
    return new Response("attribution failed", { status: 500 });
  }

  return new Response();
};
