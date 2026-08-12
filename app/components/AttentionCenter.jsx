import { useNavigate } from "react-router";
import { useEffect, useRef, useState } from "react";
import { SEMANTIC, worstSeverity } from "../semantic-colors";

/**
 * Outstanding work, reachable from every page.
 *
 * Previously a floating card, which was wrong twice over: it sat on top of the
 * dashboard competing with the real content, and it behaved like a toast when
 * the information is persistent state a merchant needs to come back to. A toast
 * says "creator approved"; this says "PKR 102 is waiting" — those want different
 * furniture.
 *
 * Now a small bell that stays out of the way until opened. The badge is coloured
 * by the worst severity present, not by how many items there are: one broken
 * tracking setup is red, five routine approvals are amber.
 */
export function AttentionCenter({ items = [], signature }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  // Close on outside click and on Escape, as any popover should.
  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Reopening should reflect reality: if the work changed, drop the open state.
  useEffect(() => setOpen(false), [signature]);

  if (!items.length) return null;

  const severity = worstSeverity(items);
  const badge = SEMANTIC[severity] ?? SEMANTIC.neutral;

  return (
    <div
      ref={containerRef}
      style={{ position: "fixed", right: "20px", bottom: "20px", zIndex: 520 }}
    >
      {open && (
        <div
          role="dialog"
          aria-label="Needs your attention"
          style={{
            position: "absolute",
            right: 0,
            bottom: "56px",
            width: "min(380px, calc(100vw - 40px))",
            background: "#fff",
            border: `1px solid ${SEMANTIC.neutral.tint}`,
            borderRadius: "12px",
            boxShadow: "0 12px 32px -8px rgba(20,30,60,.22), 0 2px 8px rgba(20,30,60,.08)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "13px 16px",
              borderBottom: "1px solid #E1E3E5",
            }}
          >
            <span style={{ fontSize: "13.5px", fontWeight: 650, color: SEMANTIC.neutral.text }}>
              Needs your attention
            </span>
            <span
              style={{
                fontSize: "11px",
                fontWeight: 700,
                color: "#fff",
                background: badge.solid,
                borderRadius: "100px",
                padding: "2px 8px",
              }}
            >
              {items.length}
            </span>
          </div>

          <div style={{ maxHeight: "60vh", overflowY: "auto" }}>
            {items.map((item) => {
              const tone = SEMANTIC[item.severity] ?? SEMANTIC.neutral;
              return (
                <div
                  key={item.id}
                  style={{
                    // A 3px accent carries the severity without tinting the whole
                    // row, which would turn the panel into a colour chart.
                    borderLeft: `3px solid ${tone.solid}`,
                    background: tone.tint,
                    padding: "12px 16px",
                    borderBottom: "1px solid #F1F2F4",
                  }}
                >
                  <div
                    style={{
                      fontSize: "10.5px",
                      fontWeight: 700,
                      letterSpacing: ".04em",
                      textTransform: "uppercase",
                      color: tone.text,
                      marginBottom: "3px",
                    }}
                  >
                    {item.category}
                  </div>
                  <div style={{ fontSize: "13.5px", fontWeight: 600, color: SEMANTIC.neutral.text }}>
                    {item.title}
                  </div>
                  <div style={{ fontSize: "12.5px", color: "#6D7175", margin: "3px 0 9px", lineHeight: 1.45 }}>
                    {item.detail}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      navigate(item.url);
                    }}
                    style={{
                      font: "inherit",
                      fontSize: "12.5px",
                      fontWeight: 600,
                      color: tone.text,
                      background: "#fff",
                      border: `1px solid ${tone.solid}33`,
                      borderRadius: "8px",
                      padding: "5px 11px",
                      cursor: "pointer",
                    }}
                  >
                    {item.action} →
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <button
        type="button"
        aria-label={`Needs your attention: ${items.length} item${items.length === 1 ? "" : "s"}`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          position: "relative",
          width: "44px",
          height: "44px",
          borderRadius: "50%",
          background: "#fff",
          border: "1px solid #D6D9DD",
          boxShadow: "0 4px 14px -4px rgba(20,30,60,.25)",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: SEMANTIC.neutral.text,
        }}
      >
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        <span
          style={{
            position: "absolute",
            top: "-4px",
            right: "-4px",
            minWidth: "19px",
            height: "19px",
            padding: "0 5px",
            borderRadius: "100px",
            background: badge.solid,
            color: "#fff",
            fontSize: "11px",
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "2px solid #fff",
          }}
        >
          {items.length}
        </span>
      </button>
    </div>
  );
}
