import prisma from "../db.server";

// Referrals that were rejected never count toward revenue or order totals.
const EARNING_REFERRAL = { not: "REJECTED" };

/**
 * Resolve a period key into the range being viewed plus the equally-long range
 * immediately before it, which is what the "vs previous period" deltas compare
 * against. Ranges are half-open: [start, end).
 *
 * Dates are computed in server-local time. Once shops outside the server's
 * timezone matter, this should read `shop.ianaTimezone` and bucket against that.
 */
export function resolvePeriod(period = "30d") {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysAgo = (n) => new Date(startOfToday.getTime() - n * 86400000);

  let start;
  let end;

  switch (period) {
    case "today":
      start = startOfToday;
      end = now;
      break;
    case "7d":
      start = daysAgo(6);
      end = now;
      break;
    case "month":
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = now;
      break;
    case "last_month":
      start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      end = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case "30d":
    default:
      start = daysAgo(29);
      end = now;
      break;
  }

  const span = end.getTime() - start.getTime();
  return {
    start,
    end,
    previousStart: new Date(start.getTime() - span),
    previousEnd: start,
  };
}

/**
 * Mirror the shop's currency into the Store row for the creators-panel, which
 * has no Admin API access. The `not` filter makes this a no-op statement on
 * every load after the first.
 */
export async function syncStoreCurrency(shop, currencyCode) {
  if (!currencyCode) return;

  await prisma.store.updateMany({
    where: { shop, currencyCode: { not: currencyCode } },
    data: { currencyCode },
  });
}

function percentChange(current, previous) {
  // With no baseline there is no meaningful percentage, so the UI shows nothing
  // rather than a fake "+100%".
  if (!previous) return null;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function sumBy(rows, key) {
  return rows.reduce((total, row) => total + (row[key] ?? 0), 0);
}

/** Day-granularity buckets spanning [start, end], each seeded at zero. */
function buildBuckets(start, end) {
  const buckets = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());

  while (cursor <= last && buckets.length < 120) {
    buckets.push({
      key: cursor.toDateString(),
      date: cursor.toLocaleDateString("en-US", { day: "numeric", month: "short" }),
      revenue: 0,
      orders: 0,
      commissions: 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }

  return buckets;
}

/**
 * Everything the merchant dashboard renders, read from the database.
 *
 * Metrics that depend on click tracking (clicks, conversion rate) are reported
 * as `null` rather than 0 — there is no Click model yet, so "0 clicks" would be
 * a claim we cannot back up. The UI renders null as "Not tracked yet".
 */
export async function getDashboardData({ shop, period = "30d", programId = "all" }) {
  const store = await prisma.store.findUnique({
    where: { shop },
    include: {
      programs: {
        include: { trackingConfig: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  if (!store || !store.onboardingCompleted) return null;

  const allPrograms = store.programs;
  const scopedPrograms =
    programId === "all" ? allPrograms : allPrograms.filter((p) => p.id === programId);
  const programIds = scopedPrograms.map((p) => p.id);

  const { start, end, previousStart, previousEnd } = resolvePeriod(period);
  const inScope = { creator: { programId: { in: programIds } } };

  // No programs in scope means every aggregate below is trivially empty, and
  // `programId: { in: [] }` would still cost a round trip per query.
  if (programIds.length === 0) {
    return emptyDashboard({ store, allPrograms, start, end });
  }

  const [
    periodReferrals,
    previousReferrals,
    periodCommissions,
    creatorCounts,
    commissionTotals,
    topCreatorRows,
    recentCreators,
    recentReferrals,
    lifetimeReferralCount,
  ] = await Promise.all([
    prisma.referral.findMany({
      where: { ...inScope, status: EARNING_REFERRAL, createdAt: { gte: start, lt: end } },
      // The commission's status is what separates attributed revenue from
      // commissionable revenue — a rejected commission never invalidates the
      // referral that earned it.
      select: { orderAmount: true, createdAt: true, commission: { select: { status: true } } },
    }),
    prisma.referral.findMany({
      where: {
        ...inScope,
        status: EARNING_REFERRAL,
        createdAt: { gte: previousStart, lt: previousEnd },
      },
      select: { orderAmount: true },
    }),
    prisma.commission.findMany({
      where: { ...inScope, createdAt: { gte: start, lt: end } },
      select: { amount: true, createdAt: true },
    }),
    prisma.creator.groupBy({
      by: ["status"],
      where: { programId: { in: programIds } },
      _count: { _all: true },
    }),
    prisma.commission.groupBy({
      by: ["status"],
      where: inScope,
      _sum: { amount: true },
    }),
    prisma.referral.groupBy({
      by: ["creatorId"],
      where: { ...inScope, status: EARNING_REFERRAL, createdAt: { gte: start, lt: end } },
      _sum: { orderAmount: true },
      _count: { _all: true },
      orderBy: { _sum: { orderAmount: "desc" } },
      take: 5,
    }),
    prisma.creator.findMany({
      where: { programId: { in: programIds } },
      select: {
        id: true,
        createdAt: true,
        account: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.referral.findMany({
      where: inScope,
      select: { id: true, orderNumber: true, orderAmount: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.referral.count({ where: { ...inScope, status: EARNING_REFERRAL } }),
  ]);

  // Attributed: every order a creator generated. Commissionable: the subset a
  // creator is actually owed for. They diverge as soon as a commission is
  // rejected — for a refund, say — and conflating them would erase the creator's
  // work from reporting the moment the money is clawed back.
  const revenue = sumBy(periodReferrals, "orderAmount");
  const commissionableRevenue = Number(
    periodReferrals
      .filter((referral) => referral.commission?.status !== "REJECTED")
      .reduce((total, referral) => total + referral.orderAmount, 0)
      .toFixed(2),
  );
  const previousRevenue = sumBy(previousReferrals, "orderAmount");
  const orders = periodReferrals.length;
  const previousOrders = previousReferrals.length;

  const countByStatus = Object.fromEntries(
    creatorCounts.map((row) => [row.status, row._count._all]),
  );
  const totalCreators = creatorCounts.reduce((sum, row) => sum + row._count._all, 0);

  const commissionByStatus = Object.fromEntries(
    commissionTotals.map((row) => [row.status, row._sum.amount ?? 0]),
  );

  // Chart series: fold both referral and commission rows into shared day buckets.
  const buckets = buildBuckets(start, end);
  const bucketIndex = new Map(buckets.map((bucket, i) => [bucket.key, i]));
  const addTo = (createdAt, field, value) => {
    const i = bucketIndex.get(new Date(createdAt).toDateString());
    if (i !== undefined) buckets[i][field] += value;
  };
  for (const referral of periodReferrals) {
    addTo(referral.createdAt, "revenue", referral.orderAmount);
    addTo(referral.createdAt, "orders", 1);
  }
  for (const commission of periodCommissions) {
    addTo(commission.createdAt, "commissions", commission.amount);
  }

  const topCreators = await hydrateTopCreators(topCreatorRows);

  const pendingApproval = countByStatus.PENDING ?? 0;
  const readyToPay = commissionByStatus.APPROVED ?? 0;
  const actionItems = [];
  if (pendingApproval > 0) {
    actionItems.push({
      id: "pending-creators",
      text: `${pendingApproval} creator${pendingApproval === 1 ? " is" : "s are"} waiting for approval.`,
      action: "Review creators",
      url: "/app/creators?status=PENDING",
    });
  }
  if (readyToPay > 0) {
    actionItems.push({
      id: "ready-payouts",
      text: `${readyToPay.toFixed(2)} in commissions are approved and ready to be paid.`,
      action: "Review creators",
      url: "/app/creators",
    });
  }

  const defaultProgram = allPrograms.find((p) => p.isDefault) ?? allPrograms[0] ?? null;

  return {
    hasData: lifetimeReferralCount > 0,
    programs: allPrograms.map((p) => ({ id: p.id, name: p.name })),
    defaultProgram: defaultProgram && { id: defaultProgram.id, name: defaultProgram.name },
    metrics: {
      totalRevenue: revenue,
      commissionableRevenue,
      totalRevenueChange: percentChange(revenue, previousRevenue),
      orders,
      ordersChange: percentChange(orders, previousOrders),
      // Requires a Click model + storefront tracking; not built yet.
      clicks: null,
      clicksChange: null,
      conversionRate: null,
      conversionRateChange: null,
    },
    chart: buckets.map(({ key, ...rest }) => rest), // eslint-disable-line no-unused-vars
    programHealth: {
      status: scopedPrograms.some((p) => p.status === "ACTIVE") ? "Active" : "Inactive",
      totalCreators,
      activeCreators: countByStatus.ACTIVE ?? 0,
      pendingApproval,
      linkTracking: scopedPrograms.some((p) => p.trackingConfig?.linkTrackingEnabled),
      couponTracking: scopedPrograms.some((p) => p.trackingConfig?.couponTrackingEnabled),
    },
    commissions: {
      pending: commissionByStatus.PENDING ?? 0,
      approved: readyToPay,
      paid: commissionByStatus.PAID ?? 0,
      rejected: commissionByStatus.REJECTED ?? 0,
    },
    actionItems,
    topCreators,
    recentActivity: buildActivityFeed({ recentCreators, recentReferrals }),
  };
}

/** Attach names and commission totals to the grouped referral rows. */
async function hydrateTopCreators(rows) {
  if (rows.length === 0) return [];

  const creatorIds = rows.map((row) => row.creatorId);
  const [creators, commissionRows] = await Promise.all([
    prisma.creator.findMany({
      where: { id: { in: creatorIds } },
      select: { id: true, account: { select: { firstName: true, lastName: true } } },
    }),
    prisma.commission.groupBy({
      by: ["creatorId"],
      where: { creatorId: { in: creatorIds } },
      _sum: { amount: true },
    }),
  ]);

  const nameById = new Map(
    creators.map((c) => [c.id, `${c.account.firstName} ${c.account.lastName}`.trim()]),
  );
  const commissionById = new Map(
    commissionRows.map((row) => [row.creatorId, row._sum.amount ?? 0]),
  );

  return rows.map((row) => ({
    id: row.creatorId,
    name: nameById.get(row.creatorId) ?? "Unknown creator",
    sales: row._sum.orderAmount ?? 0,
    orders: row._count._all,
    // Clicks are not tracked, so a per-creator conversion rate is not derivable.
    conversion: null,
    commission: commissionById.get(row.creatorId) ?? 0,
  }));
}

function buildActivityFeed({ recentCreators, recentReferrals }) {
  const events = [
    ...recentCreators.map((creator) => ({
      id: `creator-${creator.id}`,
      text: `${`${creator.account.firstName} ${creator.account.lastName}`.trim()} joined your creator program`,
      at: creator.createdAt,
    })),
    ...recentReferrals.map((referral) => ({
      id: `referral-${referral.id}`,
      text: `Order ${referral.orderNumber ?? ""} generated ${referral.orderAmount.toFixed(2)}`.replace(
        "  ",
        " ",
      ),
      at: referral.createdAt,
    })),
  ];

  return events
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, 5)
    .map((event) => ({
      ...event,
      at: new Date(event.at).toISOString(),
      // Formatted server-side so the markup hydrates identically on the client.
      time: timeAgo(event.at),
    }));
}

function timeAgo(value) {
  const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;

  return new Date(value).toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

function emptyDashboard({ store, allPrograms, start, end }) {
  const defaultProgram = allPrograms.find((p) => p.isDefault) ?? allPrograms[0] ?? null;

  return {
    hasData: false,
    programs: allPrograms.map((p) => ({ id: p.id, name: p.name })),
    defaultProgram: defaultProgram && { id: defaultProgram.id, name: defaultProgram.name },
    metrics: {
      totalRevenue: 0,
      commissionableRevenue: 0,
      totalRevenueChange: null,
      orders: 0,
      ordersChange: null,
      clicks: null,
      clicksChange: null,
      conversionRate: null,
      conversionRateChange: null,
    },
    chart: buildBuckets(start, end).map(({ key, ...rest }) => rest), // eslint-disable-line no-unused-vars
    programHealth: {
      status: "Inactive",
      totalCreators: 0,
      activeCreators: 0,
      pendingApproval: 0,
      linkTracking: false,
      couponTracking: false,
    },
    commissions: { pending: 0, approved: 0, paid: 0, rejected: 0 },
    actionItems: [],
    topCreators: [],
    recentActivity: [],
    storeShop: store.shop,
  };
}
