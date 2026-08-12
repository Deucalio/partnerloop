import prisma from "../db.server";

/**
 * Work that is sitting waiting for the merchant.
 *
 * Loaded on every page in the app layout rather than only the dashboard,
 * because these are things a merchant should notice while doing something else —
 * a creator who signed up on Tuesday should not stay invisible until someone
 * happens to open the dashboard on Friday.
 *
 * Each item mirrors one gap in the lifecycle:
 *
 *   tracking off     ──→ [0] nothing works at all until this is fixed
 *   creator signs up ──→ [1] approve them
 *   order attributed ──→ [2] approve the commission, create a payout
 *   payout created   ──→ [3] send the money and mark it paid
 *
 * The count means "unresolved things needing a decision", never "number of
 * events". Twenty orders from one creator is not twenty notifications.
 */

/**
 * Mirror the theme embed state so this can be read without a theme query.
 *
 * The null branch is load-bearing: `embedStatus` starts NULL, and in SQL
 * `NULL <> 'inactive'` is NULL rather than true, so a bare `not` filter would
 * never match a store that had not been checked yet — the first sync, the only
 * one that matters for a new install, would silently do nothing.
 */
export async function syncEmbedStatus(shop, state) {
  if (!state) return;
  await prisma.store.updateMany({
    where: {
      shop,
      OR: [{ embedStatus: null }, { embedStatus: { not: state } }],
    },
    data: { embedStatus: state },
  });
}

export async function getAttentionItems(shop) {
  const scopedCommissions = { creator: { program: { shopId: shop } } };

  const [store, pendingCreators, approved, unpaidPayouts, owedAdjustments] = await Promise.all([
    prisma.store.findUnique({ where: { shop }, select: { currencyCode: true, embedStatus: true } }),

    prisma.creator.count({
      where: { status: "PENDING", program: { shopId: shop } },
    }),

    // Approved but not yet attached to a payout. Commissions already sitting in
    // a payout are *not* "ready to be paid" — they are waiting on the transfer,
    // which is a different job with a different destination.
    prisma.commission.aggregate({
      where: { ...scopedCommissions, status: "APPROVED", payoutId: null },
      _sum: { amount: true },
      _count: { _all: true },
    }),

    prisma.payout.aggregate({
      where: { creator: { program: { shopId: shop } }, status: { not: "PAID" } },
      _sum: { amount: true },
      _count: { _all: true },
    }),

    // Refunds that landed after a commission was already paid: the creator owes
    // the difference back, and nothing else surfaces that.
    prisma.commissionAdjustment.aggregate({
      where: { commission: { status: "PAID", creator: { program: { shopId: shop } } } },
      _sum: { amount: true },
    }),
  ]);

  const currency = store?.currencyCode ?? "USD";
  const money = (amount) => {
    try {
      return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount ?? 0);
    } catch {
      return `${(amount ?? 0).toFixed(2)} ${currency}`;
    }
  };

  const items = [];

  // Worst first: without tracking, none of the rest can even happen.
  if (store?.embedStatus === "inactive") {
    items.push({
      id: "tracking-inactive",
      severity: "critical",
      category: "Tracking",
      title: "Referral tracking isn't switched on",
      detail: "Creator links record nothing and no order can be credited until the app embed is enabled.",
      action: "Fix tracking",
      url: "/app",
    });
  }

  if (pendingCreators > 0) {
    items.push({
      id: "pending-creators",
      severity: "warning",
      category: "Creator approvals",
      title: `${pendingCreators} creator${pendingCreators === 1 ? "" : "s"} awaiting approval`,
      detail: "They cannot earn commission until you approve them.",
      action: "Review creators",
      url: "/app/creators?status=PENDING",
    });
  }

  if (unpaidPayouts._count._all > 0) {
    items.push({
      id: "unpaid-payouts",
      severity: "warning",
      category: "Payments",
      title: `${money(unpaidPayouts._sum.amount)} awaiting payment`,
      detail: `${unpaidPayouts._count._all} payout${unpaidPayouts._count._all === 1 ? "" : "s"} created but not marked paid.`,
      action: "Go to payouts",
      url: "/app/payouts",
    });
  }

  if (approved._count._all > 0) {
    items.push({
      id: "approved-commissions",
      severity: "info",
      category: "Payments",
      title: `${money(approved._sum.amount)} approved, not yet in a payout`,
      detail: `${approved._count._all} commission${approved._count._all === 1 ? "" : "s"} ready to be grouped into a payout.`,
      action: "Create payout",
      url: "/app/commissions?status=APPROVED",
    });
  }

  const owed = -(owedAdjustments._sum.amount ?? 0);
  if (owed > 0.005) {
    items.push({
      id: "creator-balances",
      severity: "info",
      category: "Refunds",
      title: `${money(owed)} owed back from refunds`,
      detail: "Refunds landed after these commissions were paid. Settle against a future payout.",
      action: "Review commissions",
      url: "/app/commissions?status=PAID",
    });
  }

  return {
    items,
    // Lets the panel reappear when the work changes, even if it was dismissed.
    signature: items.map((item) => `${item.id}:${item.title}`).join("|"),
  };
}
