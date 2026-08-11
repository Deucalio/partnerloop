// Shared by the dashboard route component (to render the picker) and by
// dashboard.server.js (to resolve a key into a date range). Deliberately NOT a
// `.server` module — importing one of those from a component would pull Prisma
// into the client bundle.
export const PERIODS = [
  { label: "Today", value: "today" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "This month", value: "month" },
  { label: "Last month", value: "last_month" },
];
