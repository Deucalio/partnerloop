/**
 * PartnerLoop's semantic colour vocabulary.
 *
 * The rule this encodes: the app stays Shopify-native white and grey. Colour is
 * used to convey *meaning* — never as decoration, and never across a whole card.
 * Tints, small icon containers, badges and 3px accent borders only.
 *
 * Severity, not quantity, drives colour. A badge showing "5" is amber because
 * something needs doing, not because five things do.
 *
 * A plain module rather than a `.server` one: components import it directly.
 */

export const SEMANTIC = {
  /** PartnerLoop's own accent. Reserved for creator/signup surfaces. */
  brand: { solid: "#6B2FA3", tint: "#F6F0FA", text: "#5A2589" },
  success: { solid: "#008060", tint: "#E3F5EC", text: "#006B4F" },
  info: { solid: "#0066CC", tint: "#EAF4FF", text: "#00509E" },
  warning: { solid: "#B98900", tint: "#FFF8E1", text: "#8F6A00" },
  critical: { solid: "#D72C0D", tint: "#FFF1F0", text: "#B3260B" },
  neutral: { solid: "#6D7175", tint: "#F6F6F7", text: "#202223" },
};

/** How urgent an attention item is, worst first. */
export const SEVERITY_ORDER = ["critical", "warning", "info"];

/** The colour a summary badge takes: the worst severity present, not the count. */
export function worstSeverity(items = []) {
  for (const severity of SEVERITY_ORDER) {
    if (items.some((item) => item.severity === severity)) return severity;
  }
  return "neutral";
}

/** Polaris `Badge` tones, so status language matches the palette. */
export const BADGE_TONE = {
  critical: "critical",
  warning: "attention",
  info: "info",
  success: "success",
  neutral: undefined,
};
