import { authenticate } from "../shopify.server";
import { recordClick } from "../services/tracking.server";

/**
 * Storefront click beacon, reached at /apps/partnerloop/track and forwarded here
 * by Shopify's App Proxy.
 *
 * `authenticate.public.appProxy` verifies Shopify's HMAC signature, so an
 * unsigned request from anywhere else is rejected before any work happens — the
 * endpoint is public, but not forgeable.
 *
 * Always answers 200 with a JSON body. The caller is a fire-and-forget beacon on
 * a shopper's page load: a stale or unknown code is a normal outcome, and
 * nothing about it should surface as an error in the storefront console.
 */
export const action = async ({ request }) => {
  const { session } = await authenticate.public.appProxy(request);

  // No session means the app isn't installed on the shop making the request.
  if (!session?.shop) {
    return Response.json({ ok: false, reason: "not_installed" });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, reason: "bad_payload" });
  }

  const result = await recordClick({
    shop: session.shop,
    referralCode: body?.ref,
    visitorId: body?.visitorId,
    landingPage: body?.landingPage,
    referrer: body?.referrer,
  });

  return Response.json(result);
};

// The beacon only ever POSTs; a GET here is someone poking at the URL.
export const loader = async ({ request }) => {
  await authenticate.public.appProxy(request);
  return Response.json({ ok: false, reason: "post_required" });
};
