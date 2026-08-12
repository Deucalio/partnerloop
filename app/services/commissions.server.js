import prisma from "../db.server";

/**
 * Commission lifecycle and manual payouts.
 *
 *   PENDING ──→ APPROVED ──→ PAID
 *      └────→ REJECTED
 *
 * Per-commission records are the source of truth; grouping by creator is a
 * convenience for the merchant, not a storage decision.
 *
 * Rejecting a commission never touches its `Referral`. "Sarah generated this
 * order" and "Sarah is owed for this order" are separate facts, and a refund
 * only invalidates the second.
 */

/** Every query is scoped through the creator's program to the calling shop. */
const ownedBy = (shop) => ({ creator: { program: { shopId: shop } } });

/**
 * Turn a UI tab into a query filter.
 *
 * `IN_PAYOUT` is not a stored status — it is `APPROVED` with a payout attached.
 * Keeping the split here rather than in the database means a payout can be
 * deleted or reassigned without a status migration.
 */
function tabFilter(tab) {
  switch (tab) {
    case "APPROVED":
      return { status: "APPROVED", payoutId: null };
    case "IN_PAYOUT":
      return { status: "APPROVED", payoutId: { not: null } };
    default:
      return { status: tab };
  }
}

/**
 * Commissions in one status, grouped by creator for review.
 *
 * Returns creator-level totals alongside the individual rows so a merchant can
 * bulk-approve a creator's batch or drill in and reject just one.
 */
export async function getCommissionsByCreator({ shop, status = "PENDING" }) {
  const commissions = await prisma.commission.findMany({
    where: { ...ownedBy(shop), ...tabFilter(status) },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      amount: true,
      originalAmount: true,
      status: true,
      rejectionReason: true,
      eligibleAt: true,
      approvedAt: true,
      payoutId: true,
      createdAt: true,
      adjustments: {
        orderBy: { createdAt: "asc" },
        select: { amount: true, reason: true, createdAt: true },
      },
      referral: { select: { orderId: true, orderNumber: true, orderAmount: true, createdAt: true } },
      creator: {
        select: {
          id: true,
          referralCode: true,
          account: { select: { firstName: true, lastName: true, email: true } },
          program: { select: { name: true } },
        },
      },
    },
  });

  const groups = new Map();
  const now = Date.now();

  for (const commission of commissions) {
    const creator = commission.creator;
    if (!groups.has(creator.id)) {
      groups.set(creator.id, {
        creatorId: creator.id,
        name: `${creator.account.firstName} ${creator.account.lastName}`.trim(),
        email: creator.account.email,
        referralCode: creator.referralCode,
        programName: creator.program.name,
        total: 0,
        commissions: [],
      });
    }

    const group = groups.get(creator.id);
    group.total = Number((group.total + commission.amount).toFixed(2));
    group.commissions.push({
      id: commission.id,
      amount: commission.amount,
      // Shown alongside the current figure whenever a refund has moved it, so
      // the merchant sees "Rs 130 → Rs 91" rather than a number that silently
      // differs from what they remember.
      originalAmount: commission.originalAmount,
      adjusted:
        commission.originalAmount != null && commission.originalAmount !== commission.amount,
      adjustments: commission.adjustments.map((adjustment) => ({
        amount: adjustment.amount,
        reason: adjustment.reason,
      })),
      status: commission.status,
      rejectionReason: commission.rejectionReason,
      payoutId: commission.payoutId,
      orderId: commission.referral?.orderId ?? null,
      orderNumber: commission.referral?.orderNumber ?? null,
      orderAmount: commission.referral?.orderAmount ?? 0,
      createdAt: commission.createdAt.toISOString(),
      // Surfaced so a merchant can see a commission is still inside the refund
      // window. Not enforced — approving early is allowed, just discouraged.
      eligibleAt: commission.eligibleAt ? commission.eligibleAt.toISOString() : null,
      heldUntilFuture: commission.eligibleAt ? commission.eligibleAt.getTime() > now : false,
    });
  }

  const creators = [...groups.values()].sort((a, b) => b.total - a.total);

  return {
    creators,
    total: Number(creators.reduce((sum, group) => sum + group.total, 0).toFixed(2)),
    count: commissions.length,
  };
}

/** Totals per tab, so the review screen can show counts without a query each. */
export async function getCommissionTotals(shop) {
  const [rows, inPayout] = await Promise.all([
    prisma.commission.groupBy({
      by: ["status"],
      where: ownedBy(shop),
      _sum: { amount: true },
      _count: { _all: true },
    }),
    prisma.commission.aggregate({
      where: { ...ownedBy(shop), status: "APPROVED", payoutId: { not: null } },
      _sum: { amount: true },
      _count: { _all: true },
    }),
  ]);

  const totals = Object.fromEntries(
    rows.map((row) => [row.status, { amount: row._sum.amount ?? 0, count: row._count._all }]),
  );

  // APPROVED from the groupBy covers both tabs, so split it.
  const inPayoutTotal = { amount: inPayout._sum.amount ?? 0, count: inPayout._count._all };
  const approvedTotal = totals.APPROVED ?? { amount: 0, count: 0 };

  return {
    ...totals,
    APPROVED: {
      amount: Number((approvedTotal.amount - inPayoutTotal.amount).toFixed(2)),
      count: approvedTotal.count - inPayoutTotal.count,
    },
    IN_PAYOUT: inPayoutTotal,
  };
}

/**
 * Approve commissions. Only PENDING ones move; anything else is silently left
 * alone so a double-submit cannot un-pay or re-approve something.
 */
export async function approveCommissions({ shop, commissionIds }) {
  if (!commissionIds?.length) return { count: 0 };

  return prisma.commission.updateMany({
    where: { ...ownedBy(shop), id: { in: commissionIds }, status: "PENDING" },
    data: { status: "APPROVED", approvedAt: new Date(), rejectionReason: null },
  });
}

/**
 * Reject commissions with a reason.
 *
 * Only PENDING and APPROVED can be rejected — a PAID commission is money that
 * already left the building, and pretending otherwise would desync the payout.
 * The underlying `Referral` is deliberately untouched.
 */
export async function rejectCommissions({ shop, commissionIds, reason }) {
  const trimmed = String(reason ?? "").trim();
  if (!commissionIds?.length) return { count: 0, error: null };
  if (!trimmed) return { count: 0, error: "A reason is required to reject a commission." };

  return {
    ...(await prisma.commission.updateMany({
      where: {
        ...ownedBy(shop),
        id: { in: commissionIds },
        status: { in: ["PENDING", "APPROVED"] },
        // Never pull a commission out from under a payout.
        payoutId: null,
      },
      data: { status: "REJECTED", rejectedAt: new Date(), rejectionReason: trimmed.slice(0, 500) },
    })),
    error: null,
  };
}

/**
 * Group a creator's approved commissions into a payout.
 *
 * Selection is deliberately narrow: APPROVED, belonging to this shop and this
 * creator, and **not already attached to a payout**. That last filter is what
 * makes it impossible to pay the same commission twice — a stale form or a
 * double-click simply matches zero rows the second time.
 *
 * The commissions stay APPROVED until the payout is marked paid; being linked to
 * a payout is what removes them from the selectable pool.
 */
export async function createPayout({ shop, creatorId, commissionIds, method, reference, note }) {
  const selectable = await prisma.commission.findMany({
    where: {
      ...ownedBy(shop),
      creatorId,
      status: "APPROVED",
      payoutId: null,
      ...(commissionIds?.length ? { id: { in: commissionIds } } : {}),
    },
    select: { id: true, amount: true },
  });

  if (selectable.length === 0) {
    return { payout: null, error: "No approved, unpaid commissions were available for this creator." };
  }

  const amount = Number(selectable.reduce((sum, row) => sum + row.amount, 0).toFixed(2));

  const payout = await prisma.$transaction(async (tx) => {
    const created = await tx.payout.create({
      data: {
        creatorId,
        amount,
        status: "PENDING",
        method: method?.trim() || null,
        reference: reference?.trim() || null,
        note: note?.trim() || null,
      },
    });

    await tx.commission.updateMany({
      where: { id: { in: selectable.map((row) => row.id) } },
      data: { payoutId: created.id },
    });

    return created;
  });

  return { payout, error: null, commissionCount: selectable.length };
}

/**
 * Mark a payout as actually paid.
 *
 * This is the point the money is recorded as having moved, so it is also where
 * the commissions become PAID. Reference and method are captured here because
 * they are usually only known once the transfer is made.
 */
export async function markPayoutPaid({ shop, payoutId, method, reference, note }) {
  const payout = await prisma.payout.findFirst({
    where: { id: payoutId, creator: { program: { shopId: shop } }, status: { not: "PAID" } },
    select: { id: true },
  });

  if (!payout) return { ok: false, error: "That payout is not available to mark as paid." };

  await prisma.$transaction([
    prisma.payout.update({
      where: { id: payout.id },
      data: {
        status: "PAID",
        paidAt: new Date(),
        ...(method?.trim() ? { method: method.trim() } : {}),
        ...(reference?.trim() ? { reference: reference.trim() } : {}),
        ...(note?.trim() ? { note: note.trim() } : {}),
      },
    }),
    prisma.commission.updateMany({
      where: { payoutId: payout.id, status: "APPROVED" },
      data: { status: "PAID" },
    }),
  ]);

  return { ok: true, error: null };
}

/** Payout history for the merchant, newest first. */
export async function getPayouts({ shop }) {
  const payouts = await prisma.payout.findMany({
    where: { creator: { program: { shopId: shop } } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      number: true,
      amount: true,
      status: true,
      method: true,
      reference: true,
      note: true,
      paidAt: true,
      createdAt: true,
      _count: { select: { commissions: true } },
      creator: {
        select: {
          referralCode: true,
          account: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });

  return payouts.map((payout) => ({
    id: payout.id,
    reference: payout.reference,
    label: `PL-${String(payout.number).padStart(4, "0")}`,
    amount: payout.amount,
    status: payout.status,
    method: payout.method,
    note: payout.note,
    commissionCount: payout._count.commissions,
    creatorName: `${payout.creator.account.firstName} ${payout.creator.account.lastName}`.trim(),
    referralCode: payout.creator.referralCode,
    paidAt: payout.paidAt ? payout.paidAt.toISOString() : null,
    createdAt: payout.createdAt.toISOString(),
  }));
}
