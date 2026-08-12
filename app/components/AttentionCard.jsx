import { useNavigate } from "react-router";
import { Card, BlockStack, InlineStack, Text } from "@shopify/polaris";
import { SEMANTIC, worstSeverity } from "../semantic-colors";

/**
 * The same outstanding work, pinned into the dashboard itself.
 *
 * The bell is discoverable but easy to ignore, and money waiting to move is not
 * something a merchant should have to go looking for. This shows the top few
 * items in place; the bell remains the complete list.
 */
export function AttentionCard({ items = [], limit = 3 }) {
  const navigate = useNavigate();

  if (!items.length) return null;

  const shown = items.slice(0, limit);
  const overflow = items.length - shown.length;
  const headline = SEMANTIC[worstSeverity(items)] ?? SEMANTIC.neutral;

  return (
    <Card padding="0">
      <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid #F1F2F4" }}>
        <InlineStack align="space-between" blockAlign="center">
          <Text variant="headingMd" as="h2">Needs your attention</Text>
          <span
            style={{
              fontSize: "11px",
              fontWeight: 700,
              color: "#fff",
              background: headline.solid,
              borderRadius: "100px",
              padding: "2px 8px",
            }}
          >
            {items.length}
          </span>
        </InlineStack>
      </div>

      <BlockStack gap="0">
        {shown.map((item) => {
          const tone = SEMANTIC[item.severity] ?? SEMANTIC.neutral;
          return (
            <div
              key={item.id}
              style={{
                borderLeft: `3px solid ${tone.solid}`,
                background: tone.tint,
                padding: "12px 16px",
                borderBottom: "1px solid #F1F2F4",
              }}
            >
              <div style={{ fontSize: "13px", fontWeight: 600, color: SEMANTIC.neutral.text }}>
                {item.title}
              </div>
              <div style={{ fontSize: "12px", color: "#6D7175", margin: "2px 0 8px", lineHeight: 1.4 }}>
                {item.detail}
              </div>
              <button
                type="button"
                onClick={() => navigate(item.url)}
                style={{
                  font: "inherit",
                  fontSize: "12px",
                  fontWeight: 600,
                  color: tone.text,
                  background: "#fff",
                  border: `1px solid ${tone.solid}33`,
                  borderRadius: "8px",
                  padding: "4px 10px",
                  cursor: "pointer",
                }}
              >
                {item.action} →
              </button>
            </div>
          );
        })}
      </BlockStack>

      {overflow > 0 && (
        <div style={{ padding: "10px 16px" }}>
          <Text tone="subdued" variant="bodySm">
            {`+${overflow} more in the attention centre`}
          </Text>
        </div>
      )}
    </Card>
  );
}
