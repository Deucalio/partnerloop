// Shared by the commissions route component (to render the tabs) and by
// commissions.server.js (to turn a tab into a query).
//
// Lives outside the `.server` module on purpose. Exporting a plain constant from
// a server module and importing it into a component drags Prisma into the client
// bundle and fails the build — see PROJECT_STATUS.md gotchas #2 and #2a. The rule
// that avoids it: a `.server` module should export functions only.

/**
 * The commission lifecycle as a merchant experiences it:
 *
 *   PENDING ──approve──→ APPROVED ──create payout──→ IN_PAYOUT ──pay──→ PAID
 *      └──────────────── REJECTED ────────────────────────────────────────┘
 *
 * `IN_PAYOUT` is not a database status — it is `APPROVED` with a payout attached.
 * Splitting it out matters because the two need different things from the
 * merchant: an approved commission is waiting for a payout to be created, one in
 * a payout is waiting for the money to actually be sent. Lumping them together
 * left people looking at "Approved" with no idea which still needed action.
 */
export const COMMISSION_TABS = [
  { id: "PENDING", label: "Pending", next: "Approve" },
  { id: "APPROVED", label: "Approved", next: "Create payout" },
  { id: "IN_PAYOUT", label: "In payout", next: "Mark as paid" },
  { id: "PAID", label: "Paid", next: null },
  { id: "REJECTED", label: "Rejected", next: null },
];

export const COMMISSION_TAB_IDS = COMMISSION_TABS.map((tab) => tab.id);
