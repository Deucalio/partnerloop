import prisma from "../db.server";

/** Cart attribute / cookie name the storefront embed writes the code into. */
export const REF_ATTRIBUTE = "_pl_ref";

/** Last-click attribution: a code stays valid for 30 days after the click. */
export const ATTRIBUTION_WINDOW_DAYS = 30;

/**
 * The same visitor reloading a landing page shouldn't inflate a creator's click
 * count, so repeat clicks on the same code collapse into one within this window.
 */
const DEDUPE_MINUTES = 30;

const MAX_URL_LENGTH = 2048;

function trim(value, max = MAX_URL_LENGTH) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

/**
 * Record a storefront click for a referral code.
 *
 * Returns a small result object rather than throwing: this runs on a hot
 * storefront path, and an unknown code is an ordinary outcome (a stale link, a
 * typo, a creator who was since deactivated), not an error worth 500-ing over.
 */
export async function recordClick({ shop, referralCode, visitorId, landingPage, referrer }) {
  const code = trim(referralCode, 64);
  const visitor = trim(visitorId, 64);

  if (!code || !visitor) {
    return { ok: false, reason: "missing_fields" };
  }

  const creator = await prisma.creator.findUnique({
    where: { referralCode: code },
    select: {
      id: true,
      status: true,
      programId: true,
      program: { select: { shopId: true, status: true } },
    },
  });

  // Tenancy: a code only counts on the store that owns the program it belongs
  // to, so one merchant's storefront can't log clicks against another's creator.
  if (!creator || creator.program.shopId !== shop) {
    return { ok: false, reason: "unknown_code" };
  }

  if (creator.status !== "ACTIVE" || creator.program.status !== "ACTIVE") {
    return { ok: false, reason: "inactive" };
  }

  const since = new Date(Date.now() - DEDUPE_MINUTES * 60 * 1000);
  const recent = await prisma.click.findFirst({
    where: { creatorId: creator.id, visitorId: visitor, createdAt: { gte: since } },
    select: { id: true },
  });

  if (recent) {
    return { ok: true, deduped: true };
  }

  await prisma.click.create({
    data: {
      creatorId: creator.id,
      programId: creator.programId,
      visitorId: visitor,
      landingPage: trim(landingPage) ?? "/",
      referrer: trim(referrer),
    },
  });

  return { ok: true, deduped: false };
}
