// Shared by the commissions route component (to render the tabs) and by
// commissions.server.js (to validate the requested status).
//
// Lives outside the `.server` module on purpose. Exporting a plain constant from
// a server module and importing it into a component drags Prisma into the client
// bundle and fails the build — see PROJECT_STATUS.md gotchas #2 and #2a. The rule
// that avoids it: a `.server` module should export functions only.
export const COMMISSION_TABS = [
  { id: "PENDING", label: "Pending" },
  { id: "APPROVED", label: "Approved" },
  { id: "PAID", label: "Paid" },
  { id: "REJECTED", label: "Rejected" },
];

export const COMMISSION_STATUSES = COMMISSION_TABS.map((tab) => tab.id);
