import { redirect, useLoaderData, useSubmit, useNavigate } from "react-router";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

// Only rule types that decompose onto a single line item. FIXED_PER_ORDER is a
// whole-order amount and stays program-level; see commission.server.js.
const ALLOWED_PRODUCT_RULE_TYPES = ["PERCENTAGE", "FIXED_PER_ITEM"];

// Customer-type rules replace the program default, so they accept everything the
// default does.
const ALLOWED_DEFAULT_RULE_TYPES = ["PERCENTAGE", "FIXED_PER_ORDER", "FIXED_PER_ITEM"];

export const loader = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  
  if (params.id === 'new') {
    return {
      program: {
        name: "New Affiliate Program",
        description: "",
        status: "ACTIVE",
        commissionConfig: {
          type: "PERCENTAGE",
          amount: 10,
          minimumOrderValue: null
        },
        productRules: [],
        customerRules: []
      },
      isNew: true
    };
  }

  const program = await prisma.program.findUnique({
    where: { id: params.id, shopId: session.shop },
    include: {
      commissionConfig: true,
      productRules: { orderBy: { createdAt: 'asc' } },
      customerRules: true
    }
  });

  if (!program) {
    return redirect("/app/programs");
  }

  return { program, isNew: false };
};

export const action = async ({ request, params }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  
  const name = formData.get("name") || "Untitled Program";
  const description = formData.get("description") || "";
  const status = formData.get("status") || "ACTIVE";
  const type = formData.get("commissionType") || "PERCENTAGE";
  const amount = parseFloat(formData.get("commissionAmount")) || 0;

  // Product overrides arrive as JSON from the client. Everything is re-validated
  // here: only the two line-decomposable rule types are accepted, and anything
  // malformed is dropped rather than trusted.
  let productRules = [];
  try {
    const parsed = JSON.parse(formData.get("productRules") || "[]");
    if (Array.isArray(parsed)) {
      productRules = parsed
        .filter((rule) => ALLOWED_PRODUCT_RULE_TYPES.includes(rule?.type))
        .map((rule) => ({
          productId: String(rule.productId || "").trim(),
          productTitle: String(rule.productTitle || "Untitled product").slice(0, 255),
          type: rule.type,
          amount: Number.parseFloat(rule.amount) || 0,
        }))
        .filter((rule) => rule.productId);
    }
  } catch {
    productRules = [];
  }

  // Last one wins if the same product somehow appears twice — the table has a
  // unique constraint on (programId, productId) and createMany would reject the
  // whole batch otherwise.
  const uniqueRules = [...new Map(productRules.map((r) => [r.productId, r])).values()];

  // Customer-type rules stand in for the default, so they accept all three rule
  // types — a customer is an order-level fact, unlike a product.
  let customerRules = [];
  try {
    const parsed = JSON.parse(formData.get("customerRules") || "[]");
    if (Array.isArray(parsed)) {
      customerRules = parsed
        .filter((rule) => ["NEW", "RETURNING"].includes(rule?.customerType))
        .filter((rule) => ALLOWED_DEFAULT_RULE_TYPES.includes(rule?.type))
        .map((rule) => ({
          customerType: rule.customerType,
          type: rule.type,
          amount: Number.parseFloat(rule.amount) || 0,
        }));
    }
  } catch {
    customerRules = [];
  }
  const uniqueCustomerRules = [
    ...new Map(customerRules.map((r) => [r.customerType, r])).values(),
  ];

  // Blank, zero or nonsense means "no minimum" rather than "minimum of 0".
  const parsedMinimum = Number.parseFloat(formData.get("minimumOrderValue"));
  const minimumOrderValue =
    Number.isFinite(parsedMinimum) && parsedMinimum > 0 ? parsedMinimum : null;

  if (params.id === 'new') {
    await prisma.program.create({
      data: {
        shopId: session.shop,
        name,
        description,
        status,
        commissionConfig: {
          create: {
            type,
            amount,
            minimumOrderValue
          }
        },
        trackingConfig: {
          create: {}
        },
        productRules: {
          create: uniqueRules
        },
        customerRules: {
          create: uniqueCustomerRules
        }
      }
    });
  } else {
    // Ownership is checked before the rules are touched, so a program id from
    // another shop cannot have rules written against it.
    const owned = await prisma.program.findFirst({
      where: { id: params.id, shopId: session.shop },
      select: { id: true },
    });

    if (!owned) return redirect("/app/programs");

    await prisma.$transaction([
      prisma.program.update({
        where: { id: owned.id },
        data: {
          name,
          description,
          status,
          commissionConfig: {
            update: {
              type,
              amount,
              minimumOrderValue
            }
          }
        }
      }),
      // Replace wholesale: the form posts the complete desired set, so diffing
      // would only add a way for the two to disagree.
      prisma.productCommissionRule.deleteMany({ where: { programId: owned.id } }),
      prisma.productCommissionRule.createMany({
        data: uniqueRules.map((rule) => ({ ...rule, programId: owned.id })),
      }),
      prisma.customerCommissionRule.deleteMany({ where: { programId: owned.id } }),
      prisma.customerCommissionRule.createMany({
        data: uniqueCustomerRules.map((rule) => ({ ...rule, programId: owned.id })),
      }),
    ]);
  }

  return redirect("/app/programs");
};

export default function EditProgram() {
  const { program, isNew } = useLoaderData();
  const navigate = useNavigate();
  const submit = useSubmit();

  const [name, setName] = useState(program.name);
  const [description, setDescription] = useState(program.description || "");
  const [status, setStatus] = useState(program.status);
  const [commissionType, setCommissionType] = useState(program.commissionConfig?.type || "PERCENTAGE");
  const [commissionAmount, setCommissionAmount] = useState(program.commissionConfig?.amount?.toString() || "10");

  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);

  const [productRules, setProductRules] = useState(() =>
    (program.productRules || []).map((rule) => ({
      productId: rule.productId,
      productTitle: rule.productTitle,
      type: rule.type,
      amount: String(rule.amount),
    })),
  );

  const [customerRules, setCustomerRules] = useState(() => {
    const saved = Object.fromEntries(
      (program.customerRules || []).map((rule) => [rule.customerType, rule]),
    );
    const seed = (customerType, fallbackAmount) => ({
      enabled: Boolean(saved[customerType]),
      type: saved[customerType]?.type ?? 'PERCENTAGE',
      amount: String(saved[customerType]?.amount ?? fallbackAmount),
    });
    return { NEW: seed('NEW', 15), RETURNING: seed('RETURNING', 5) };
  });

  const [minimumOrderValue, setMinimumOrderValue] = useState(
    program.commissionConfig?.minimumOrderValue != null
      ? String(program.commissionConfig.minimumOrderValue)
      : '',
  );

  const updateCustomerRule = (customerType, patch) =>
    setCustomerRules((current) => ({
      ...current,
      [customerType]: { ...current[customerType], ...patch },
    }));

  /**
   * App Bridge's product picker. `shopify` is a global the embedded App Bridge
   * script installs; guarded because it is absent outside the Shopify admin.
   */
  const pickProducts = async () => {
    if (typeof shopify === "undefined" || !shopify?.resourcePicker) return;

    const selection = await shopify.resourcePicker({ type: "product", multiple: true });
    if (!selection?.length) return;

    setProductRules((current) => {
      const seen = new Set(current.map((rule) => rule.productId));
      const additions = selection
        .filter((product) => !seen.has(product.id))
        .map((product) => ({
          productId: product.id,
          productTitle: product.title,
          type: "PERCENTAGE",
          amount: "20",
        }));
      return [...current, ...additions];
    });
  };

  const updateRule = (productId, patch) =>
    setProductRules((current) =>
      current.map((rule) => (rule.productId === productId ? { ...rule, ...patch } : rule)),
    );

  const removeRule = (productId) =>
    setProductRules((current) => current.filter((rule) => rule.productId !== productId));

  const handleSave = () => {
    const formData = new FormData();
    formData.append("name", name);
    formData.append("description", description);
    formData.append("status", status);
    formData.append("commissionType", commissionType);
    formData.append("commissionAmount", commissionAmount);
    formData.append("productRules", JSON.stringify(productRules));
    formData.append(
      "customerRules",
      JSON.stringify(
        Object.entries(customerRules)
          .filter(([, rule]) => rule.enabled)
          .map(([customerType, rule]) => ({ customerType, type: rule.type, amount: rule.amount })),
      ),
    );
    formData.append("minimumOrderValue", minimumOrderValue);

    submit(formData, { method: "post" });
  };

  const handleDiscard = () => {
    navigate("/app/programs");
  };

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

        :root{
          --blue-900:#1E3A8A;
          --blue-800:#1D4ED8;
          --blue-600:#2563EB;
          --blue-tint:#EEF4FF;
          --blue-tint-2:#DBEAFE;
          --amber-600:#F59E0B;
          --amber-400:#FFB648;
          --amber-tint:#FFF6E5;
          --amber-text:#92620A;
          --ink:#161A25;
          --muted:#6B7280;
          --muted-2:#8A93A3;
          --green-bg:#DEFBE8;
          --green-text:#0F8A4B;
          --border:#E4E8F0;
          --border-soft:#EBEEF4;
        }
        .programs-page *{box-sizing:border-box;}
        .programs-page{ font-family:'Inter',system-ui,-apple-system,sans-serif; background:#F0F2F6; color:var(--ink); margin: -1rem;}
        .programs-page .page{ max-width:1280px; margin:0 auto; padding:24px 28px 70px; }

        /* ===== top bar ===== */
        .programs-page .top-bar{ display:flex; align-items:center; justify-content:space-between; margin-bottom:22px; }
        .programs-page .top-left{ display:flex; align-items:center; gap:14px; }
        .programs-page .back-btn{ width:36px; height:36px; border-radius:9px; border:1px solid var(--border); background:#fff; display:flex; align-items:center; justify-content:center; color:#374151; cursor:pointer; flex:none; }
        .programs-page .back-btn:hover{ border-color:#C7CFDC; }
        .programs-page .top-titles h1{ margin:0; font-size:20px; font-weight:800; letter-spacing:-.01em; }
        .programs-page .top-titles .sub{ font-size:12.5px; color:var(--muted); margin-top:2px; }
        .programs-page .top-actions{ display:flex; gap:10px; }
        .programs-page .btn{ display:inline-flex; align-items:center; gap:7px; font-family:inherit; font-size:13.5px; font-weight:600; padding:10px 16px; border-radius:10px; cursor:pointer; border:1px solid var(--border); background:#fff; color:#374151; }
        .programs-page .btn:hover{ border-color:#C7CFDC; }
        .programs-page .btn.primary{ background:linear-gradient(135deg,var(--blue-600),var(--blue-900)); color:#fff; border:none; box-shadow:0 6px 14px -6px rgba(29,78,216,.5); }

        /* ===== layout ===== */
        .programs-page .layout{ display:grid; grid-template-columns:1fr 336px; gap:20px; align-items:start; }
        .programs-page .main-col{ display:flex; flex-direction:column; gap:22px; }

        .programs-page .section-head{ margin-bottom:2px; }
        .programs-page .section-head h2{ margin:0 0 3px; font-size:15.5px; font-weight:700; }
        .programs-page .section-head p{ margin:0; font-size:13px; color:var(--muted); }
        .programs-page .section-stack{ display:flex; flex-direction:column; gap:14px; }

        /* ===== generic card ===== */
        .programs-page .card{ background:#fff; border:1px solid var(--border-soft); border-radius:16px; padding:22px 24px; box-shadow:0 1px 2px rgba(20,30,60,.03); position:relative; }
        .programs-page .card-title-row{ display:flex; align-items:center; gap:10px; margin-bottom:4px; }
        .programs-page .card-title-row h3{ margin:0; font-size:14.5px; font-weight:700; }
        .programs-page .card-desc{ margin:0 0 16px; font-size:13px; color:var(--muted); line-height:1.5; }

        .programs-page .pill{ font-size:11px; font-weight:700; padding:3px 10px; border-radius:100px; }
        .programs-page .pill.active{ background:var(--green-bg); color:var(--green-text); }
        .programs-page .pill.inactive{ background:var(--amber-tint); color:var(--amber-text); border:1px solid #FBE3B0; }
        .programs-page .pill.pro{ display:inline-flex; align-items:center; gap:4px; background:linear-gradient(135deg,#FFE1A0,var(--amber-400)); color:#5A3400; }

        /* ===== form field styles ===== */
        .programs-page .field-row{ display:grid; gap:14px; }
        .programs-page .field-row.two{ grid-template-columns:1fr 220px; }
        .programs-page .field-row.three{ grid-template-columns:1fr 1fr; }
        .programs-page .field{ border:1px solid var(--border); border-radius:11px; padding:11px 14px; background:#fff; }
        .programs-page .field label{ display:block; font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; margin-bottom:5px; }
        .programs-page .field .val{ font-size:14px; color:var(--ink); font-weight:500; }
        .programs-page .field input { border:none; outline:none; font-family:inherit; font-size:14px; font-weight:500; color:var(--ink); width: 100%; padding:0; background:transparent;}
        .programs-page .field.select{ display:flex; align-items:center; justify-content:space-between; cursor:pointer; position:relative;}
        .programs-page .field.select svg{ color:var(--muted-2); flex:none; }
        .programs-page .field.status{ display:flex; align-items:center; justify-content:space-between; }
        .programs-page .field textarea{ width:100%; border:none; outline:none; resize:vertical; font-family:inherit; font-size:13.5px; color:#374151; line-height:1.55; min-height:64px; padding:0; margin-top:2px; }
        .programs-page .field-hint{ font-size:12px; color:var(--muted-2); font-style:italic; margin-top:8px; }
        .programs-page .field .amount-suffix{ display:flex; align-items:center; justify-content:space-between; }
        .programs-page .field .amount-suffix .unit{ color:var(--muted-2); font-weight:600; font-size:13px; }
        
        .programs-page .dropdown-menu { position:absolute; top:calc(100% + 4px); left:0; width:100%; background:#fff; border:1px solid var(--border); border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.1); z-index:10; overflow:hidden;}
        .programs-page .dropdown-item { padding:10px 14px; font-size:13px; font-weight:500; cursor:pointer; }
        .programs-page .dropdown-item:hover { background:var(--border-soft); }

        .programs-page .toggle{ width:36px; height:20px; border-radius:100px; background:var(--blue-600); position:relative; flex:none; cursor:pointer; }
        .programs-page .toggle::after{ content:""; position:absolute; top:2px; right:2px; width:16px; height:16px; border-radius:50%; background:#fff; transition:right .15s ease; }
        .programs-page .toggle.off{ background:#D7DCE5; }
        .programs-page .toggle.off::after{ right:18px; }
        .programs-page .toggle.locked{ background:#E7EAF1; cursor:not-allowed; }
        .programs-page .toggle.locked::after{ right:18px; background:#fff; }

        .programs-page .card-cta-row{ display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }

        /* ===== advanced commission rows ===== */
        .programs-page .adv-row{ border:1px solid var(--border); border-radius:12px; padding:14px 16px; display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
        .programs-page .adv-row + .adv-row{ margin-top:10px; }
        .programs-page .adv-row-left{ flex:1; }
        .programs-page .adv-row-title{ display:flex; align-items:center; gap:7px; font-size:13.5px; font-weight:700; margin-bottom:4px; }
        .programs-page .info-dot{ color:var(--muted-2); cursor:help; flex:none; }
        .programs-page .adv-row-desc{ font-size:12.5px; color:var(--muted); line-height:1.5; max-width:52ch; }
        .programs-page .adv-row-right{ display:flex; align-items:center; gap:10px; flex:none; }

        /* ===== info-note rows (self-referral etc.) ===== */
        .programs-page .note-row{ display:flex; align-items:flex-start; justify-content:space-between; gap:16px; }
        .programs-page .note-row-left{ flex:1; }
        .programs-page .note-title{ display:flex; align-items:center; gap:7px; font-size:13.5px; font-weight:700; margin-bottom:4px; }
        .programs-page .note-desc{ font-size:12.5px; color:var(--muted); line-height:1.5; max-width:54ch; }

        /* ===== sidebar ===== */
        .programs-page .sidebar{ display:flex; flex-direction:column; gap:16px; position:sticky; top:20px; }
        .programs-page .side-card{ background:#fff; border:1px solid var(--border-soft); border-radius:16px; padding:20px 22px; box-shadow:0 1px 2px rgba(20,30,60,.03); }
        .programs-page .side-card h3{ margin:0 0 4px; font-size:14.5px; font-weight:700; }

        .programs-page .summary-name-row{ display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; }
        .programs-page .summary-name{ font-size:14px; font-weight:700; line-height:1.4; padding-right:8px; }
        .programs-page .summary-sub{ font-size:12px; color:var(--muted); margin-bottom:14px; display:flex; align-items:center; gap:6px; }
        .programs-page .summary-sub svg{ color:var(--blue-600); flex:none; }

        .programs-page .summary-block-title{ font-size:11.5px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:.03em; margin-bottom:9px; }
        .programs-page .summary-list{ margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:8px; }
        .programs-page .summary-list li{ display:flex; align-items:flex-start; gap:8px; font-size:13px; color:#374151; line-height:1.45; }
        .programs-page .summary-list li::before{ content:""; width:5px;height:5px; border-radius:50%; background:var(--blue-600); margin-top:6px; flex:none; }

        .programs-page .tip-card{ display:flex; gap:11px; }
        .programs-page .tip-icon{ width:30px;height:30px; border-radius:9px; background:linear-gradient(135deg,#FFDE9E,var(--amber-400)); display:flex; align-items:center; justify-content:center; flex:none; }
        .programs-page .tip-body{ font-size:13px; color:#374151; line-height:1.5; }
        .programs-page .tip-link{ display:inline-block; margin-top:6px; font-size:12.5px; font-weight:700; color:var(--blue-600); text-decoration:none; }

        .programs-page .ai-card{ position:relative; border:1px solid transparent; background:
            linear-gradient(#fff,#fff) padding-box,
            linear-gradient(135deg, var(--blue-600), var(--amber-400)) border-box;
          border-radius:16px; padding:20px 22px; }
        .programs-page .ai-head{ display:flex; align-items:center; gap:9px; margin-bottom:6px; }
        .programs-page .ai-icon{ width:28px; height:28px; border-radius:8px; background:linear-gradient(135deg,var(--blue-600),var(--blue-900)); display:flex; align-items:center; justify-content:center; color:#fff; flex:none; }
        .programs-page .ai-head h3{ margin:0; font-size:14px; font-weight:700; }
        .programs-page .ai-badge{ font-size:10px; font-weight:800; letter-spacing:.04em; color:#fff; background:linear-gradient(135deg,var(--blue-600),var(--blue-900)); padding:2px 7px; border-radius:5px; margin-left:2px; }
        .programs-page .ai-body{ font-size:13px; color:#374151; line-height:1.5; margin-bottom:8px; }
        .programs-page .ai-link{ font-size:12.5px; font-weight:700; color:var(--blue-800); text-decoration:none; }

        @media (max-width:980px){
          .programs-page .layout{ grid-template-columns:1fr; }
          .programs-page .sidebar{ position:static; }
          .programs-page .field-row.two, .programs-page .field-row.three{ grid-template-columns:1fr; }
        }
      `}</style>
      
      <div className="programs-page">
        <div className="page">
          <div className="top-bar">
            <div className="top-left">
              <div className="back-btn" onClick={handleDiscard}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
              </div>
              <div className="top-titles">
                <h1>{isNew ? 'Create program' : 'Edit program'}</h1>
                <div className="sub">Programs / {name || "Untitled Program"}</div>
              </div>
            </div>
            <div className="top-actions">
              <button className="btn" onClick={handleDiscard}>Discard</button>
              <button className="btn primary" onClick={handleSave}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                Save changes
              </button>
            </div>
          </div>

          <div className="layout">
            <div className="main-col">

              {/* General information */}
              <div className="card">
                <div className="card-title-row"><h3>General information</h3></div>
                <div className="field-row two" style={{marginBottom: '14px'}}>
                  <div className="field">
                    <label>Name</label>
                    <input className="val" value={name} onChange={(e) => setName(e.target.value)} placeholder="Program Name" />
                  </div>
                  <div className="field status">
                    <div>
                      <label style={{marginBottom: '2px'}}>Status</label>
                    </div>
                    <div className={`toggle ${status === 'ACTIVE' ? '' : 'off'}`} onClick={() => setStatus(s => s === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE')}></div>
                  </div>
                </div>
                <div className="field">
                  <label>Description (optional)</label>
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Explain your program terms here..."></textarea>
                </div>
                <div className="field-hint">This is displayed on the affiliate account and registration page.</div>
              </div>

              {/* Commission rules */}
              <div className="section-head">
                <h2>Commission rules</h2>
                <p>Configure how affiliates earn on referral sales.</p>
              </div>
              <div className="section-stack">

                <div className="card">
                  <div className="card-title-row"><h3>Default commission</h3></div>
                  <p className="card-desc">Set a base commission rate that affiliates earn for every referral.</p>
                  <div className="field select" style={{marginBottom: '14px'}}>
                    <div><label>Rule</label><div className="val">Simple (Fixed Commission)</div></div>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M7 10l5 5 5-5"/></svg>
                  </div>
                  <div className="field-row two">
                    <div className="field select" onClick={() => setTypeDropdownOpen(!typeDropdownOpen)}>
                      <div>
                        <label>Type</label>
                        <div className="val">
                          {commissionType === 'PERCENTAGE' && 'Percent of sale'}
                          {commissionType === 'FIXED_PER_ORDER' && 'Fixed amount per order'}
                          {commissionType === 'FIXED_PER_ITEM' && 'Fixed amount per item'}
                        </div>
                      </div>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M7 10l5 5 5-5"/></svg>
                      {typeDropdownOpen && (
                        <div className="dropdown-menu">
                          <div className="dropdown-item" onClick={() => { setCommissionType('PERCENTAGE'); setTypeDropdownOpen(false); }}>Percent of sale</div>
                          <div className="dropdown-item" onClick={() => { setCommissionType('FIXED_PER_ORDER'); setTypeDropdownOpen(false); }}>Fixed amount per order</div>
                          <div className="dropdown-item" onClick={() => { setCommissionType('FIXED_PER_ITEM'); setTypeDropdownOpen(false); }}>Fixed amount per item</div>
                        </div>
                      )}
                    </div>
                    <div className="field">
                      <label>Amount</label>
                      <div className="amount-suffix">
                        <input className="val" type="number" step="0.01" value={commissionAmount} onChange={(e) => setCommissionAmount(e.target.value)} />
                        <span className="unit">{commissionType === 'PERCENTAGE' ? '%' : '$'}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="card">
                  <div className="card-cta-row">
                    <div>
                      <div className="card-title-row">
                        <h3>Special product commission</h3>
                        {productRules.length > 0
                          ? <span className="pill">{productRules.length} product{productRules.length === 1 ? '' : 's'}</span>
                          : <span className="pill inactive">Inactive</span>}
                      </div>
                      <p className="card-desc" style={{marginBottom: '0'}}>Set different commission rates when specific products are purchased. These override the default rate for those products only.</p>
                    </div>
                    <button className="btn" onClick={pickProducts}>
                      {productRules.length > 0 ? 'Add products' : 'Set up'}
                    </button>
                  </div>

                  {productRules.length > 0 && (
                    <div style={{ marginTop: '16px', borderTop: '1px solid var(--border-soft)', paddingTop: '4px' }}>
                      {productRules.map((rule) => {
                        // Product GIDs contain characters that make awkward DOM ids.
                        const fieldId = rule.productId.replace(/[^a-zA-Z0-9]/g, '-');
                        return (
                        <div
                          key={rule.productId}
                          style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', padding: '12px 0', borderBottom: '1px solid var(--border-soft)' }}
                        >
                          <div style={{ flex: '1 1 40%', minWidth: 0 }}>
                            <div style={{ fontSize: '11px', fontWeight: 700, color: 'var(--muted-2)', textTransform: 'uppercase', letterSpacing: '.03em', marginBottom: '5px' }}>Product</div>
                            <div style={{ fontSize: '13.5px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={rule.productTitle}>
                              {rule.productTitle}
                            </div>
                          </div>

                          <div className="field" style={{ flex: '0 0 180px' }}>
                            <label htmlFor={`rule-type-${fieldId}`}>Type</label>
                            <select
                              id={`rule-type-${fieldId}`}
                              className="val"
                              style={{ border: 'none', outline: 'none', background: 'transparent', font: 'inherit', width: '100%' }}
                              value={rule.type}
                              onChange={(e) => updateRule(rule.productId, { type: e.target.value })}
                            >
                              <option value="PERCENTAGE">Percent of sale</option>
                              <option value="FIXED_PER_ITEM">Fixed amount per item</option>
                            </select>
                          </div>

                          <div className="field" style={{ flex: '0 0 130px' }}>
                            <label htmlFor={`rule-amount-${fieldId}`}>Amount</label>
                            <div className="amount-suffix">
                              <input
                                id={`rule-amount-${fieldId}`}
                                className="val"
                                type="number"
                                step="0.01"
                                min="0"
                                value={rule.amount}
                                onChange={(e) => updateRule(rule.productId, { amount: e.target.value })}
                              />
                              <span className="unit">{rule.type === 'PERCENTAGE' ? '%' : '$'}</span>
                            </div>
                          </div>

                          <button
                            className="btn"
                            style={{ flex: 'none', color: 'var(--red-text)' }}
                            onClick={() => removeRule(rule.productId)}
                            aria-label={`Remove ${rule.productTitle}`}
                          >
                            Remove
                          </button>
                        </div>
                        );
                      })}
                      <p className="card-desc" style={{ marginTop: '12px', marginBottom: 0 }}>
                        Anything not listed here earns the default commission above.
                      </p>
                    </div>
                  )}
                </div>

                <div className="card">
                  <div className="card-title-row"><h3>Advanced commission</h3></div>
                  <p className="card-desc">Set different commission rates when specific conditions are met. These override the default rate for matching referrals.</p>

                  {[
                    { key: 'NEW', title: 'New customer commission', desc: 'Pay a different rate when the referred customer is purchasing from your store for the first time.' },
                    { key: 'RETURNING', title: 'Returning customer commission', desc: 'Pay a different rate when the referred customer has ordered from you before.' },
                  ].map(({ key, title, desc }) => {
                    const rule = customerRules[key];
                    return (
                      <div className="adv-row" key={key} style={{ flexWrap: 'wrap' }}>
                        <div className="adv-row-left">
                          <div className="adv-row-title">{title}</div>
                          <div className="adv-row-desc">{desc}</div>
                        </div>
                        <div className="adv-row-right">
                          <button
                            type="button"
                            className={`toggle ${rule.enabled ? '' : 'off'}`}
                            aria-pressed={rule.enabled}
                            aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${title}`}
                            onClick={() => updateCustomerRule(key, { enabled: !rule.enabled })}
                            style={{ border: 'none', padding: 0 }}
                          />
                        </div>

                        {rule.enabled && (
                          <div style={{ display: 'flex', gap: '12px', width: '100%', marginTop: '12px' }}>
                            <div className="field" style={{ flex: '0 0 220px' }}>
                              <label htmlFor={`cust-type-${key}`}>Type</label>
                              <select
                                id={`cust-type-${key}`}
                                className="val"
                                style={{ border: 'none', outline: 'none', background: 'transparent', font: 'inherit', width: '100%' }}
                                value={rule.type}
                                onChange={(e) => updateCustomerRule(key, { type: e.target.value })}
                              >
                                <option value="PERCENTAGE">Percent of sale</option>
                                <option value="FIXED_PER_ORDER">Fixed amount per order</option>
                                <option value="FIXED_PER_ITEM">Fixed amount per item</option>
                              </select>
                            </div>
                            <div className="field" style={{ flex: '0 0 140px' }}>
                              <label htmlFor={`cust-amount-${key}`}>Amount</label>
                              <div className="amount-suffix">
                                <input
                                  id={`cust-amount-${key}`}
                                  className="val"
                                  type="number"
                                  step="0.01"
                                  min="0"
                                  value={rule.amount}
                                  onChange={(e) => updateCustomerRule(key, { amount: e.target.value })}
                                />
                                <span className="unit">{rule.type === 'PERCENTAGE' ? '%' : '$'}</span>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}

                  <div className="adv-row" style={{ flexWrap: 'wrap' }}>
                    <div className="adv-row-left">
                      <div className="adv-row-title">Minimum order value</div>
                      <div className="adv-row-desc">Orders below this subtotal earn no commission at all, whichever rule would otherwise apply. Leave blank for no minimum.</div>
                    </div>
                    <div className="adv-row-right">
                      <div className="field" style={{ flex: '0 0 140px' }}>
                        <label htmlFor="minimum-order-value">Minimum</label>
                        <div className="amount-suffix">
                          <input
                            id="minimum-order-value"
                            className="val"
                            type="number"
                            step="0.01"
                            min="0"
                            placeholder="None"
                            value={minimumOrderValue}
                            onChange={(e) => setMinimumOrderValue(e.target.value)}
                          />
                          <span className="unit">$</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="adv-row">
                    <div className="adv-row-left">
                      <div className="adv-row-title">Lifetime commissions
                        <span className="info-dot"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/></svg></span>
                      </div>
                      <div className="adv-row-desc">Keep paying commission on every future purchase by a customer this affiliate originally referred, not just their first order.</div>
                    </div>
                    <div className="adv-row-right"><span className="pill pro">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>PRO</span><div className="toggle locked"></div></div>
                  </div>

                  <div className="adv-row">
                    <div className="adv-row-left">
                      <div className="adv-row-title">Special coupon commission
                        <span className="info-dot"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/></svg></span>
                      </div>
                      <div className="adv-row-desc">Set a unique commission rate for orders placed with a specific coupon code, overriding the default rate.</div>
                    </div>
                    <div className="adv-row-right"><span className="pill pro">
                      <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>PRO</span><div className="toggle locked"></div></div>
                  </div>
                </div>
              </div>

              {/* Customer incentives */}
              <div className="section-head">
                <h2>Customer incentives</h2>
                <p>Reward customers when they shop through affiliate links.</p>
              </div>
              <div className="section-stack">
                <div className="card">
                  <div className="card-cta-row">
                    <div>
                      <div className="card-title-row"><h3>Auto-discount for customers</h3><span className="pill inactive">Inactive</span><span className="pill pro">
                        <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>PRO</span></div>
                      <p className="card-desc" style={{marginBottom: '0'}}>Automatically apply a discount at checkout when customers arrive through an affiliate link, to drive conversions.</p>
                    </div>
                    <button className="btn">Set up</button>
                  </div>
                </div>
              </div>

              {/* Commission calculation */}
              <div className="section-head">
                <h2>Commission calculation</h2>
                <p>Customize how products, shipping, and taxes impact commission calculations.</p>
              </div>
              <div className="section-stack">

                <div className="card">
                  <div className="card-title-row"><h3>Excluded products/collections</h3><span className="pill pro">
                    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>PRO</span></div>
                  <p className="card-desc">Select products or collections to exclude from commission calculations — useful for gift cards, subscriptions, or other non-commissionable items.</p>
                  <div className="field select">
                    <div><label>Apply to</label><div className="val" style={{color: 'var(--muted-2)', fontWeight: '400'}}>None selected</div></div>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6"><path d="M7 10l5 5 5-5"/></svg>
                  </div>
                </div>

                <div className="card">
                  <div className="card-title-row"><h3>Shipping, taxes and other fees</h3></div>
                  <p className="card-desc" style={{marginBottom: '14px'}}>Choose which order components count toward the commissionable amount.</p>

                  <div className="adv-row"><div className="adv-row-left"><div className="adv-row-title" style={{marginBottom: '0'}}>Exclude product tax</div></div><div className="toggle"></div></div>
                  <div className="adv-row"><div className="adv-row-left"><div className="adv-row-title" style={{marginBottom: '0'}}>Exclude shipping</div></div><div className="toggle"></div></div>
                  <div className="adv-row"><div className="adv-row-left"><div className="adv-row-title" style={{marginBottom: '0'}}>Exclude shipping tax</div></div><div className="toggle"></div></div>
                  <div className="adv-row"><div className="adv-row-left"><div className="adv-row-title" style={{marginBottom: '0'}}>Exclude tip</div></div><div className="toggle"></div></div>
                </div>

                <div className="card">
                  <div className="card-title-row"><h3>Self-referrals</h3></div>
                  <div className="note-row">
                    <div className="note-row-left">
                      <div className="note-title">Exclude self-referrals
                        <span className="info-dot"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/></svg></span>
                      </div>
                      <div className="note-desc">When enabled, affiliates won't earn commission on purchases made using their own referral link or coupon — helps prevent self-referral abuse.</div>
                    </div>
                    <div className="toggle off"></div>
                  </div>
                </div>

              </div>
            </div>

            {/* ===== sidebar ===== */}
            <div className="sidebar">

              <div className="side-card">
                <div className="summary-name-row">
                  <span className="summary-name">{name || "Untitled Program"}</span>
                  {status === 'ACTIVE' ? <span className="pill active">Active</span> : <span className="pill inactive">Inactive</span>}
                </div>
                <div className="summary-sub">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 4-6 8-6s8 2 8 6"/></svg>
                  {isNew ? '0' : '1'} affiliate using this program
                </div>
                <div className="summary-block-title">Commission structure</div>
                <ul className="summary-list">
                  <li><b>{commissionAmount}{commissionType === 'PERCENTAGE' ? '%' : '$'}</b> commission on qualifying sales</li>
                  <li>Excludes product tax, shipping, shipping tax, and tip</li>
                  <li>Self-referrals currently <b>allowed</b></li>
                </ul>
              </div>

              <div className="side-card tip-card">
                <div className="tip-icon">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#7A4B00" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18h6M10 22h4M15.09 14c.3-.53.66-.94 1.14-1.42A6 6 0 1 0 6.9 9.55"/><path d="M12 4a6 6 0 0 0-4.1 10.36c.48.48.84.89 1.14 1.42"/></svg>
                </div>
                <div className="tip-body">
                  Applying auto-discount for customers helps reduce checkout abandonment and can boost affiliate conversion rate by <b>up to 18%</b>.
                  <a className="tip-link" href="#">Enable now →</a>
                </div>
              </div>

              <div className="ai-card">
                <div className="ai-head">
                  <div className="ai-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8z"/></svg>
                  </div>
                  <h3>Smart program setup <span className="ai-badge">AI</span></h3>
                </div>
                <div className="ai-body">Launch with confidence. Let AI suggest commission rules tailored to your industry and product catalog.</div>
                <a className="ai-link" href="#">Try it now →</a>
              </div>

            </div>
          </div>

        </div>
      </div>
    </>
  );
}
