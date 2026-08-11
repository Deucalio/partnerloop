// The creator-facing portal (promote/creators-panel) is deployed separately from
// this embedded admin app, so every creator-facing URL is built from its origin.
const DEV_FALLBACK = "http://localhost:3001";

export function creatorsPanelOrigin() {
  return (process.env.CREATORS_PANEL_URL || DEV_FALLBACK).replace(/\/+$/, "");
}

/** The link a merchant shares to recruit creators into a specific program. */
export function programSignupUrl(programId) {
  return `${creatorsPanelOrigin()}/join/${programId}`;
}
