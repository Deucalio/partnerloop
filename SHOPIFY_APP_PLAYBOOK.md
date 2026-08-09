# Shopify App Development Playbook — Hard-Won Lessons

A checklist + deep-dive of the issues that bit us building **Customer Analytics: VIP & LTV**
(embedded Shopify app, React Router 7 + Polaris + Prisma/Postgres, deployed on Vercel).

**Why this file exists:** most of these problems are *invisible on a small dev store* and only
explode in production or at App Store review. Read this before building the next app — and point
your AI agent at it — so none of them are rediscovered the hard way.

> Stack note: examples use `@shopify/shopify-app-react-router` (JS). The concepts are identical for
> the Remix template (`@shopify/shopify-app-remix`); only import paths differ.

---

## 0. TL;DR pre-launch checklist

**Correctness / scale**

- [ ] No GraphQL query fans out into deep nested connections (customers → orders → lineItems → …). Keep list queries flat; load detail on demand. **(§1)**
- [ ] All paginated Admin queries go through a cost-aware wrapper that shrinks page size on `MAX_COST_EXCEEDED` and waits out `THROTTLED`. **(§1)**
- [ ] Webhook handlers ACK in well under 5s — no heavy work inline. **(§2)**
- [ ] No "fire-and-forget" work after returning a response (breaks on serverless). **(§2, §7)**
- [ ] Bulk write loops (e.g. tagging N customers) use bounded concurrency, not a serial `for` loop. **(§7)**

**Submission blockers**

- [ ] 3 mandatory GDPR webhooks implemented + declared with `compliance_topics`. **(§3)**
- [ ] Public privacy policy page reachable without auth. **(§5)**
- [ ] Only request scopes you actually use; request Protected Customer Data access if needed. **(§10)**
- [ ] Managed-pricing subscription gate wired (if paid). **(§4)**

**Deployment config**

- [ ] Every env var set in the host (Vercel), not just `.env` — especially `SHOPIFY_APP_URL`. **(§6)**
- [ ] `shopify app deploy` run so the toml (URLs, scopes, webhooks) is pushed to Shopify. **(§6)**
- [ ] `redirect_urls` matches `authPathPrefix` (`/auth/callback`, not `/api/auth`). **(§6)**
- [ ] `.env` git-ignored; secrets never committed. **(§8)**

---

## 1. GraphQL query cost limit (1000 points) — the silent production killer

### Symptom

```
Error: Sync failed after 3 attempts: Query cost is 1092, which exceeds the
single query max cost limit (1000).
```

Works perfectly in `shopify app dev`; crashes the moment it hits a real store.

### Root cause

Shopify prices every GraphQL query by a **calculated cost**, capped at **1000 points for a single
query** (separate from the throttle bucket). Two things people get wrong:

1. **Cost is charged on the *requested* fields, not the rows returned.** A query for
   `customers(first: 250)` with a nested `orders(first: 10) { lineItems { variant { product } } }`
   costs ~1000+ points *even on a store with 3 customers*, because Shopify prices the **shape** it
   might have to resolve. That's why a tiny dev store passes and production dies.
2. **Nested connections multiply.** Each connection level adds cost per item at every level.
   `250 customers × 10 orders × 10 line items` is an enormous requested cost.

### Fixes (in order of preference)

1. **Split into a lean list query + on-demand detail.** Fetch only cheap scalars and the 1–2
   dates/fields you need for the list/aggregate. Load line items / heavy nested data *only* for the
   handful of records actually on screen, via a resource route.
   - This app: [analytics.server.js](app/services/analytics.server.js) `CUSTOMERS_CORE_QUERY`
     (scalars + first/last order date only) → [customerDetails.server.js](app/services/customerDetails.server.js)
     + route [app.api.customer-details.jsx](app/routes/app.api.customer-details.jsx) for details.
2. **Cost-aware pagination wrapper.** Halve the page size on `MAX_COST_EXCEEDED`, wait out
   `THROTTLED`, remember the page size that worked. See [shopifyGraphql.server.js](app/services/shopifyGraphql.server.js).
3. **Bulk Operations** for genuinely large exports — `bulkOperationRunQuery` runs async and isn't
   subject to the single-query cost cap. Use when you truly need *all* records.

### How the error surfaces in code (so you can catch it)

The client returns **HTTP 200** with an `errors` array; the Shopify client turns cost/throttle
errors into a **thrown** `GraphqlQueryError` whose `.body` carries `extensions.code`
(`MAX_COST_EXCEEDED` / `THROTTLED`) and cost details. Catch it, read the code, and react — don't
just blindly retry (a too-expensive query costs the same every attempt).

### Rule of thumb

> If a single query has more than one level of nested connection, assume it will exceed the cost
> limit at scale. Flatten it or paginate it.

---

## 2. Webhooks must ACK fast (~5s) — never do heavy work inline

### Symptom

Order/customer webhooks time out; Shopify marks delivery failed and **re-delivers** (up to ~19
times over 48h). On a busy store, each event kicks off duplicate heavy work → a stampede.

### Root causes

- Shopify expects a **2xx within ~5 seconds**. Anything slower is a failed delivery.
- Doing a full data re-sync / re-computation inside the handler blows that deadline.
- **Serverless (Vercel) freezes the function once you return** — so you *cannot* return `200` and
  then keep working in the background. That pattern silently drops the work.

### Pattern: record a marker, ACK, recompute lazily on read

1. Webhook handler: write a tiny "something changed" marker row and return `200` immediately.
2. The next time the UI loads, treat any marker newer than your last cached result as
   cache-invalidation and recompute **once** (debounces 100 webhooks into 1 recompute).

This app: webhooks call `recordDataChangeEvent()` ([webhooks.server.js](app/services/webhooks.server.js));
[analytics.server.js](app/services/analytics.server.js) `getOrFetchAnalytics` invalidates its
snapshot when a newer `WebhookEvent` exists. Before: every `orders/create` ran a full sync inline.

### Also

- **Idempotency:** Shopify may deliver the same webhook more than once. Handlers must be safe to run
  twice.
- **Don't store the full payload** unless you use it — order payloads are large. Store shop + topic
  + timestamp.
- If you genuinely need background processing, use a real queue/cron, not post-response work.

---

## 3. Mandatory GDPR / compliance webhooks (App Store submission blocker)

Shopify **will not approve** an app that doesn't implement all three privacy webhooks. They're
declared with `compliance_topics` (NOT `topics`) so Shopify routes them specially.

### The three topics

| Topic                      | When it fires                                   | What your handler must do                                                 |
| -------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------- |
| `customers/data_request` | Customer asks (via merchant) what data you hold | Provide/confirm the data. If you store no standalone profile, ACK`200`. |
| `customers/redact`       | Customer data must be erased                    | Delete/anonymize that customer's PII from your storage.                   |
| `shop/redact`            | 48h after uninstall                             | Delete**all** data for that shop.                                   |

### toml (compliance_topics, not topics)

```toml
[[webhooks.subscriptions]]
uri = "/webhooks/customers/data_request"
compliance_topics = [ "customers/data_request" ]

[[webhooks.subscriptions]]
uri = "/webhooks/customers/redact"
compliance_topics = [ "customers/redact" ]

[[webhooks.subscriptions]]
uri = "/webhooks/shop/redact"
compliance_topics = [ "shop/redact" ]
```

### Notes

- `authenticate.webhook(request)` verifies the HMAC and rejects forged requests with 401 — always
  call it first.
- Even if you only cache Shopify data, you still must handle these (redact your caches; delete on
  shop redact).
- This app: [webhooks.customers.data_request.jsx](app/routes/webhooks.customers.data_request.jsx),
  [webhooks.customers.redact.jsx](app/routes/webhooks.customers.redact.jsx),
  [webhooks.shop.redact.jsx](app/routes/webhooks.shop.redact.jsx).

---

## 4. Managed pricing (Shopify App Pricing) + subscription gating

### Concept

Modern paid apps use **Shopify App Pricing** ("Managed Pricing"): plans are defined in the Partner
Dashboard, Shopify hosts the plan-selection page, and there's **no billing code** (no
`appSubscriptionCreate` / `billing.request()`). The app's only job is to detect shops without an
active subscription and forward them to the hosted page — because Shopify only *forces* plan
selection on App Store installs, not on direct/dev installs.

### The gate pattern

1. In the app layout loader, query the subscription state:
   ```graphql
   query { currentAppInstallation { activeSubscriptions { id } app { handle } } }
   ```
2. If `activeSubscriptions` is empty → redirect to a small internal loading screen
   (`/app/select-plan`) that breaks out of the iframe to:
   ```
   https://admin.shopify.com/store/<store>/charges/<app-handle>/pricing_plans
   ```
3. **Exempt the select-plan route** from the gate or it redirects to itself.

This app: [billing.server.js](app/services/billing.server.js),
[app.select-plan.jsx](app/routes/app.select-plan.jsx), gate in [app.jsx](app/routes/app.jsx).

### Getting the app handle right (this tripped us up)

- The pricing URL needs the **app handle** (the `/apps/<handle>` segment of the embedded URL). It
  can have a numeric suffix if the base name was taken (e.g. `cod-guard-15`).
- **Don't hardcode it blindly.** Derive it at runtime from `currentAppInstallation.app.handle`, with
  an env override (`SHOPIFY_APP_HANDLE`) as a safety hatch.
- To look up any app's handle by its API key (great for verifying):
  ```graphql
  query { appByKey(apiKey: "<your_client_id>") { title handle } }
  ```

### Two safety rules

- **Fail open.** A billing-check error must never lock a merchant out of the app — default to
  "let them through."
- **Flag-guard until plans exist.** If the gate is always-on before you've configured plans in the
  Partner Dashboard, every merchant gets bounced to an empty pricing page and the app is unusable.
  Gate it behind an env flag (`BILLING_GATE_ENABLED`) you flip on *after* plans are set up, as the
  final pre-submission step.

---

## 5. Privacy policy page

- Required for the App Store listing and for merchants to read before installing.
- Serve it as a **public route with no Shopify auth** (a loader-only route that returns an HTML
  `Response`, no default component).
- Must describe: what data you access, why, where it's stored, retention, and the deletion process
  (tie it to your `shop/redact` behavior). Include a real support email.
- This app: [privacy.jsx](app/routes/privacy.jsx).

---

## 6. Production deployment (Vercel) — "embedded app shows the template landing page"

### Symptom

Clicking the app in admin shows the template's public "A short heading about [your app]" login
page **inside** the embedded frame, instead of your dashboard.

### What's actually happening

`/` only redirects to `/app` when it receives a `?shop=` param from Shopify's launch. When embedded
**auth can't complete in production**, that redirect never happens and you fall through to the
public landing page. Causes, in order of likelihood:

1. **Env vars not set on the host.** `.env` is git-ignored, so *nothing in it is deployed*. Set
   these in Vercel → Settings → Environment Variables:
   - `SHOPIFY_APP_URL` = your production URL (e.g. `https://your-app.vercel.app`) — **the critical
     one**; auth URLs can't be built without it.
   - `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `DATABASE_URL`, `SCOPES`.
2. **Config never pushed to Shopify.** Editing `shopify.app.toml` is local only. Run
   `shopify app deploy` to register the App URL, redirect URLs, scopes, and webhooks with Shopify.
3. **`redirect_urls` mismatch.** With `authPathPrefix: "/auth"`, the callback is `/auth/callback`
   (handled by `auth.$.jsx`). A stale `/api/auth` (old template default) 404s. Fix it in the toml.
4. **Stale session.** After fixing 1–3, reinstall / reopen so a fresh offline token exists for the
   production URL: visit `https://<app-url>/auth?shop=<store>.myshopify.com`.

### The trap that re-breaks it

`automatically_update_urls_on_dev = true` in the toml means **running `shopify app dev` again
overwrites your App URL in the Partner Dashboard back to the dev tunnel**, breaking production. After
any dev session, re-run `shopify app deploy` (or set that flag to `false`) before relying on prod.

---

## 7. Serverless-safe coding patterns (general)

- **No work after the response.** Serverless functions freeze on return; background work is lost.
  Move it to the next request, a queue, or a cron job.
- **Bounded concurrency for bulk operations.** A serial `for` loop doing one API call per record
  will exceed the function timeout at scale. Run N in parallel with a concurrency limit.
  - This app: tagging N customers went from a sequential loop to bounded concurrency
    ([tagging.server.js](app/services/tagging.server.js)). Even so — for *thousands* of records,
    move to a background job / Bulk Operation; concurrency only buys you ~10×.
- **Everything idempotent.** Webhooks retry; loaders run on every navigation; assume repeats.
- **Fail open on non-critical checks** (billing, telemetry) so they can't brick the core app.

---

## 8. Secrets & config hygiene

- `.env` must be git-ignored (it is by default in the template). Never commit API secrets or DB URLs.
- Set the *same* values in the host's env settings — local `.env` does not deploy.
- If a DB is reachable on a public IP, lock it down (firewall/allowlist), don't rely on obscurity.
- Keep a vendored *reference* app out of your build/lint/typecheck: add it to `.gitignore`,
  `.eslintignore`, and `tsconfig` `exclude` (otherwise its errors pollute `npm run typecheck`).

---

## 9. Handy diagnostic queries

**Find your app handle / verify identity by API key**

```graphql
query { appByKey(apiKey: "<client_id>") { title handle apiKey embedded published } }
```

**Check current subscription state (what the gate uses)**

```graphql
query { currentAppInstallation { activeSubscriptions { id name status } app { handle } } }
```

**Inspect query cost** — every response includes it under `extensions`:

```json
"extensions": { "cost": { "requestedQueryCost": 1092, "actualQueryCost": 0,
  "throttleStatus": { "maximumAvailable": 1000, "currentlyAvailable": 0, "restoreRate": 50 } } }
```

`requestedQueryCost > 1000` = single-query-limit failure. Watch it while developing queries.

---

## 10. Full App Store submission checklist

**Access & data**

- [ ] Request only scopes you actually exercise (reviewers check unused scopes).
- [ ] If you read protected customer fields (name/email/phone/address, order details), request
  **Protected Customer Data access** in Partner Dashboard → API access. This is a *separate*
  review on its own timeline — start it early. Webhooks/queries touching that data are blocked
  until approved.
- [ ] 3 GDPR compliance webhooks (§3).
- [ ] Privacy policy URL live (§5).

**Listing assets** (design tasks — can't be generated from code)

- [ ] App icon: 1200×1200 PNG, no transparency, no text.
- [ ] Feature image: 1600×900, branded graphic, minimal text, no UI chrome.
- [ ] 3–6 screenshots: 1600×900, real screenshots of the live app (reviewers compare to the product).
- [ ] App name ≤ 30 chars; subtitle ≤ 62 chars; write as natural sentences (no keyword stuffing).

**Pricing** (if paid)

- [ ] Plans created via Shopify App Pricing in the Partner Dashboard.
- [ ] "Free for partners and developers" checked so dev stores / reviewers see $0.
- [ ] Subscription gate enabled (§4).

**Review info**

- [ ] Testing instructions for reviewers (prerequisites, step-by-step, which pages do what).
- [ ] Confirm reviewer can install on their own dev store (or provide test creds).
- [ ] Run the Partner Dashboard's built-in pre-submission checklist — it flags missing
  webhooks/scopes/GDPR setup automatically.

**Common rejection reasons**

- Screenshots that don't match the live app.
- Feature image with text/screenshot chrome.
- Scopes requested but not used.
- Incomplete privacy policy (must cover data collected, retention, deletion).
- Missing/incorrect GDPR webhooks.

---

## Appendix — reusable code sketches

### Cost-aware paginator (generic)

```js
// Halve page size on MAX_COST_EXCEEDED; wait out THROTTLED; remember what worked.
async function paginate(admin, query, { label, extract, initial = 100, min = 10, maxItems = Infinity }) {
  let size = learned.get(label) ?? initial, cursor = null, nodes = [];
  while (nodes.length < maxItems) {
    try {
      const { data } = await runQuery(admin, query, { first: Math.min(size, maxItems - nodes.length), after: cursor });
      const conn = extract(data);
      learned.set(label, size);
      nodes.push(...(conn?.nodes ?? []));
      if (!conn?.pageInfo?.hasNextPage) break;
      cursor = conn.pageInfo.endCursor;
    } catch (e) {
      if (e.code === "MAX_COST_EXCEEDED" && size > min) { size = Math.max(min, size >> 1); continue; }
      throw e;
    }
  }
  return nodes;
}
```

### Fast-ACK webhook

```js
export const action = async ({ request }) => {
  const { topic, shop } = await authenticate.webhook(request); // verifies HMAC
  await recordChange(shop, topic);          // one cheap insert
  return new Response(null, { status: 200 }); // ACK now; recompute lazily on next read
};
```

### Subscription gate (fail-open, flag-guarded)

```js
if (process.env.BILLING_GATE_ENABLED === "true" && url.pathname !== "/app/select-plan") {
  const { hasSubscription } = await getSubscriptionState(admin); // never throws
  if (!hasSubscription) throw redirect(`/app/select-plan?${url.searchParams}`);
}
```

---

*Compiled from real fixes made to Customer Analytics: VIP & LTV. Keep it next to the next app's
README and hand it to your AI agent at the start of the build.*
