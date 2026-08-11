/**
 * Detects whether the storefront tracking app embed is switched on.
 *
 * Deliberately free of database imports: this only talks to the Admin API, and
 * keeping it standalone means the parsing below can be unit tested directly.
 */

/** Matches the block filename in extensions/partnerloop-tracking/blocks/. */
const BLOCK_REFERENCE = "/blocks/partnerloop-tracking/";

/**
 * App embed blocks are off until a merchant enables them in the theme editor,
 * so without this check the first support ticket is "why are my numbers zero".
 *
 * Returns "unknown" rather than "inactive" whenever the theme can't be read
 * (missing scope, API error, unexpected shape). A detection failure must never
 * show the merchant a warning that isn't true.
 */
export async function getEmbedStatus(admin) {
  try {
    const response = await admin.graphql(
      `#graphql
      query TrackingEmbedStatus {
        themes(first: 1, roles: [MAIN]) {
          nodes {
            id
            name
            files(filenames: ["config/settings_data.json"], first: 1) {
              nodes {
                body {
                  ... on OnlineStoreThemeFileBodyText {
                    content
                  }
                }
              }
            }
          }
        }
      }`,
    );

    const payload = await response.json();
    const theme = payload?.data?.themes?.nodes?.[0];

    if (!theme) return { state: "unknown", themeId: null, themeName: null };

    const themeId = numericThemeId(theme.id);
    const content = theme.files?.nodes?.[0]?.body?.content;

    if (!content) return { state: "unknown", themeId, themeName: theme.name };

    return {
      state: isEmbedEnabled(content) ? "active" : "inactive",
      themeId,
      themeName: theme.name,
    };
  } catch {
    return { state: "unknown", themeId: null, themeName: null };
  }
}

function numericThemeId(gid) {
  if (typeof gid !== "string") return null;
  return gid.split("/").pop() || null;
}

/**
 * Strip `/* *\/` and `//` comments, ignoring anything inside string literals.
 *
 * The string-awareness is not optional: every app embed type is a URL of the
 * form `shopify://apps/...`, so a naive line-comment strip would truncate the
 * exact values we're looking for.
 */
function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }

    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }

    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", i + 2);
      i = end === -1 ? text.length : end - 1;
      continue;
    }

    out += char;
  }

  return out;
}

/**
 * App embeds live in `current.blocks` of settings_data.json, keyed by a random
 * id, with a type like:
 *   shopify://apps/<app>/blocks/partnerloop-tracking/<extension uuid>
 * An embed the merchant switched off keeps its entry but gains `disabled: true`.
 *
 * Note the file is JSONC, not JSON — Shopify writes an "auto-generated, do not
 * edit" banner comment at the top. Parsing it raw always throws, which would
 * silently report every correctly-configured store as inactive.
 */
export function isEmbedEnabled(settingsDataJson) {
  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(settingsDataJson));
  } catch {
    return false;
  }

  const blocks = parsed?.current?.blocks;
  if (!blocks || typeof blocks !== "object") return false;

  return Object.values(blocks).some(
    (block) =>
      typeof block?.type === "string" &&
      block.type.includes(BLOCK_REFERENCE) &&
      block.disabled !== true,
  );
}
