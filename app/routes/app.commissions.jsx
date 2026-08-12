import { useLoaderData, useSearchParams, useSubmit, useNavigation, useActionData } from "react-router";
import {
  Page,
  Modal,
  TextField,
  Select,
} from "@shopify/polaris";
import { useCallback, useMemo, useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  approveCommissions,
  createPayout,
  getCommissionsByCreator,
  getCommissionTotals,
  rejectCommissions,
} from "../services/commissions.server";
import { getCreatorBalances } from "../services/refunds.server";
import { COMMISSION_TABS, COMMISSION_TAB_IDS } from "../commission-tabs";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const requested = url.searchParams.get("status");
  const status = COMMISSION_TAB_IDS.includes(requested) ? requested : "PENDING";

  const response = await admin.graphql(`#graphql
    query { shop { currencyCode } }`);
  const currency = (await response.json()).data?.shop?.currencyCode || "USD";

  const [{ creators, total, count }, totals, balances] = await Promise.all([
    getCommissionsByCreator({ shop: session.shop, status }),
    getCommissionTotals(session.shop),
    // Money already paid out that a later refund clawed back.
    getCreatorBalances(session.shop),
  ]);

  return { creators, total, count, totals, status, currency, balances };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const commissionIds = String(formData.get("commissionIds") || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (intent === "approve") {
    const { count } = await approveCommissions({ shop: session.shop, commissionIds });
    return { ok: true, message: `${count} commission${count === 1 ? "" : "s"} approved.` };
  }

  if (intent === "reject") {
    // Collect both reason and notes
    const reason = formData.get("reason");
    const notes = formData.get("notes");
    const fullReason = notes ? `${reason} - ${notes}` : reason;
    
    const result = await rejectCommissions({
      shop: session.shop,
      commissionIds,
      reason: fullReason,
    });
    if (result.error) return { ok: false, message: result.error };
    return { ok: true, message: `${result.count} commission${result.count === 1 ? "" : "s"} rejected.` };
  }

  if (intent === "payout") {
    const { payout, error, commissionCount } = await createPayout({
      shop: session.shop,
      creatorId: formData.get("creatorId"),
      commissionIds,
    });
    if (error) return { ok: false, message: error };
    return {
      ok: true,
      message: `Payout created for ${commissionCount} commission${commissionCount === 1 ? "" : "s"}. Mark it paid once the transfer is made.`,
      payoutId: payout.id,
    };
  }

  return { ok: false, message: "Unknown action" };
};

export default function Commissions() {
  const { creators, total, count, totals, status, currency, balances } = useLoaderData();
  const [, setSearchParams] = useSearchParams();
  const submit = useSubmit();
  const navigation = useNavigation();
  const actionData = useActionData();

  const [selected, setSelected] = useState(() => new Set());
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const [searchQuery, setSearchQuery] = useState("");
  
  // Reject Modal State
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState("Order cancelled");
  const [notes, setNotes] = useState("");

  // Details Drawer/Modal State
  const [detailsCommission, setDetailsCommission] = useState(null);
  const [showLifecycle, setShowLifecycle] = useState(false);

  // "submitting" then "loading" — stay busy across both so a button cannot be
  // pressed twice while the list is still refetching.
  const isBusy = navigation.state !== "idle";

  // Show toast on success
  useEffect(() => {
    if (actionData?.message) {
      shopify.toast.show(actionData.message);
    }
  }, [actionData]);

  const formatMoney = useCallback(
    (amount) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount),
    [currency],
  );

  const tabs = useMemo(
    () =>
      COMMISSION_TABS.map((tab) => ({
        id: tab.id,
        content: tab.label,
        badge: String(totals[tab.id]?.count ?? 0),
      })),
    [totals],
  );

  const changeTab = useCallback(
    (id) => {
      setSelected(new Set());
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set("status", id);
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  const toggle = (id, e) => {
    if (e) e.stopPropagation();
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleCreator = (group, e) => {
    if (e) e.stopPropagation();
    setSelected((current) => {
      const next = new Set(current);
      const ids = group.commissions.map((c) => c.id);
      const allSelected = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allSelected) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  };

  const toggleCollapse = (creatorId, e) => {
    if (e) e.stopPropagation();
    setCollapsedGroups(current => {
      const next = new Set(current);
      if (next.has(creatorId)) next.delete(creatorId);
      else next.add(creatorId);
      return next;
    });
  };

  const run = (intent, ids, extra = {}) =>
    submit({ intent, commissionIds: ids.join(","), ...extra }, { method: "post" });

  const REJECTION_REASONS = [
    { label: "Order cancelled", value: "Order cancelled" },
    { label: "Fraudulent order", value: "Fraudulent order" },
    { label: "Invalid referral", value: "Invalid referral" },
    { label: "Customer refund", value: "Customer refund" },
    { label: "Commission rule violation", value: "Commission rule violation" },
    { label: "Other", value: "Other" },
  ];

  let emptyHeading = "";
  let emptySubheading = "";
  let summaryText = "";

  if (status === "PENDING") {
    summaryText = "awaiting review";
    emptyHeading = "No commissions waiting for review";
    emptySubheading = "New commissions will appear here when creators generate orders.";
  } else if (status === "APPROVED") {
    summaryText = "ready for payout";
    emptyHeading = "No commissions ready for payout";
    emptySubheading = "Approve pending commissions to see them here.";
  } else if (status === "PAID") {
    summaryText = "paid";
    emptyHeading = "No commissions have been paid yet";
    emptySubheading = "When you create a payout and mark it paid, it appears here.";
  } else if (status === "REJECTED") {
    summaryText = "rejected";
    emptyHeading = "No rejected commissions";
    emptySubheading = "Commissions you reject will be recorded here.";
  }

  // Filter logic
  const filteredCreators = useMemo(() => {
    if (!searchQuery.trim()) return creators;
    const q = searchQuery.toLowerCase();
    
    return creators.map(group => {
      if (
        group.name.toLowerCase().includes(q) ||
        group.email.toLowerCase().includes(q) ||
        group.referralCode.toLowerCase().includes(q)
      ) {
        return group;
      }
      
      const matchingCommissions = group.commissions.filter(c => 
        (c.orderNumber && c.orderNumber.toLowerCase().includes(q))
      );
      
      if (matchingCommissions.length > 0) {
        return {
          ...group,
          commissions: matchingCommissions,
          total: matchingCommissions.reduce((sum, c) => sum + c.amount, 0)
        };
      }
      
      return null;
    }).filter(Boolean);
  }, [creators, searchQuery]);

  // CSV Export logic
  const exportCSV = useCallback(() => {
    const rows = [
      ["Creator Name", "Email", "Program", "Referral Code", "Order ID", "Original Amount", "Final Amount", "Status", "Date", "Payout ID", "Rejection Reason"]
    ];

    filteredCreators.forEach(group => {
      group.commissions.forEach(c => {
        rows.push([
          `"${group.name.replace(/"/g, '""')}"`,
          `"${group.email.replace(/"/g, '""')}"`,
          `"${group.programName.replace(/"/g, '""')}"`,
          `"${group.referralCode.replace(/"/g, '""')}"`,
          `"${c.orderNumber || ''}"`,
          c.originalAmount != null ? c.originalAmount : c.amount,
          c.amount,
          `"${c.status}"`,
          `"${new Date(c.createdAt).toLocaleDateString()}"`,
          `"${c.payoutId || ''}"`,
          `"${(c.rejectionReason || '').replace(/"/g, '""')}"`
        ]);
      });
    });

    const csvContent = "data:text/csv;charset=utf-8," + rows.map(e => e.join(",")).join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `commissions-${status.toLowerCase()}-${new Date().toISOString().split('T')[0]}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [filteredCreators, status]);


  return (
    <Page fullWidth>
      <TitleBar title="Commissions" />
      
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

        :root {
          --page-bg: #f4f5f7;
          --blue-900: #1E3A8A;
          --blue-800: #1D4ED8;
          --blue: #2954e0;
          --blue-dark: #132f8c;
          --blue-50: #eef2fe;
          --navy: #1b2545;
          --amber-bg: #FFFBEB;
          --amber-text: #D97706;
          --amber-border: #FDE68A;
          --green-bg: #e3f6ec;
          --green-text: #0e7a4d;
          --red-bg: #fdeceb;
          --red-text: #b3261e;
          --ink: #1a1c1f;
          --ink-secondary: #6b7177;
          --ink-muted: #9297a0;
          --border: #e4e6ea;
          --border-soft: #EBEEF4;
          --white: #ffffff;
          --shadow-card: 0 1px 2px rgba(20,22,30,.04), 0 10px 30px rgba(20,22,30,.05);
          --shadow-mini: 0 12px 24px rgba(19,25,60,.22);
        }

        .commissions-page * { box-sizing: border-box; }
        .commissions-page { font-family: 'Inter', system-ui, sans-serif; background: var(--page-bg); color: var(--ink); margin: -1rem; min-height: 100vh; }
        .commissions-page .page-inner { max-width: 1180px; margin: 0 auto; padding: 40px 32px 80px; }

        /* SAAS Illustration */
        .saas-illustration-container { width: 100%; height: 380px; border-radius: 24px; overflow: hidden; background: linear-gradient(135deg, #347FF0 0%, #2859C8 50%, #213E92 100%); position: relative; margin-bottom: 32px; box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.2), 0 12px 24px rgba(33,62,146,0.15); }
        .bg-dot-pattern { position: absolute; inset: 0; background-image: radial-gradient(rgba(255, 255, 255, 0.15) 1.5px, transparent 1.5px); background-size: 24px 24px; mask-image: radial-gradient(circle at center, black 20%, transparent 90%); -webkit-mask-image: radial-gradient(circle at center, black 20%, transparent 90%); z-index: 1; }
        .bg-glow-orb { position: absolute; width: 350px; height: 350px; background: radial-gradient(circle, rgba(96, 165, 250, 0.35) 0%, transparent 70%); top: 50%; left: 50%; transform: translate(-40%, -50%); border-radius: 50%; z-index: 1; filter: blur(20px); }
        .bg-curves { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none; }
        @keyframes floatY1 { 0% { transform: translateY(0px); } 100% { transform: translateY(-10px); } }
        @keyframes floatY2 { 0% { transform: translateY(0px); } 100% { transform: translateY(-12px); } }
        @keyframes floatY3 { 0% { transform: translateY(0px); } 100% { transform: translateY(-8px); } }
        @keyframes floatY4 { 0% { transform: translateY(0px); } 100% { transform: translateY(-14px); } }
        @keyframes floatIcon1 { 0% { transform: translate(0, 0) rotate(0deg); } 100% { transform: translate(5px, -15px) rotate(15deg); } }
        @keyframes floatIcon2 { 0% { transform: translate(0, 0) scale(1); } 100% { transform: translate(-10px, -10px) scale(1.1); } }
        .card-wrapper { position: absolute; z-index: 5; }
        .wrap-creator { top: 8%; left: 8%; transform: rotate(-3deg); z-index: 6; }
        .wrap-order { top: 48%; left: 16%; transform: rotate(2deg); z-index: 7; }
        .wrap-commission { top: 14%; left: 45%; transform: rotate(-1.5deg); z-index: 10; }
        .wrap-payout { top: 58%; left: 66%; transform: rotate(3.5deg); z-index: 8; }
        .float-inner { animation-direction: alternate; animation-iteration-count: infinite; animation-timing-function: ease-in-out; }
        .wrap-creator .float-inner { animation-name: floatY1; animation-duration: 5s; animation-delay: 0s; }
        .wrap-order .float-inner { animation-name: floatY2; animation-duration: 6s; animation-delay: -1.5s; }
        .wrap-commission .float-inner { animation-name: floatY3; animation-duration: 7s; animation-delay: -3s; }
        .wrap-payout .float-inner { animation-name: floatY4; animation-duration: 4.5s; animation-delay: -1s; }
        .ui-card { background: rgba(255, 255, 255, 0.96); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-radius: 16px; border: 1px solid rgba(255, 255, 255, 1); box-shadow: 0 16px 32px -8px rgba(12, 28, 64, 0.3), 0 4px 12px -4px rgba(12, 28, 64, 0.15), inset 0 1px 0px rgba(255, 255, 255, 1); padding: 16px; color: #111827; width: 210px; display: flex; flex-direction: column; }
        .ui-card.main-card { width: 250px; padding: 22px; transform: scale(1.1); box-shadow: 0 24px 48px -12px rgba(10, 20, 50, 0.4), 0 8px 24px -6px rgba(10, 20, 50, 0.2), inset 0 1px 0px rgba(255, 255, 255, 1), 0 0 0 1px rgba(255, 255, 255, 0.5); }
        .ui-card.small-card { width: 190px; }
        .text-tiny { font-size: 10px; text-transform: uppercase; letter-spacing: 0.6px; font-weight: 700; color: #6B7280; margin-bottom: 4px; }
        .text-medium { font-size: 13px; font-weight: 600; color: #111827; line-height: 1.3; margin-bottom: 2px; }
        .text-sub { font-size: 11px; font-weight: 500; color: #6B7280; line-height: 1.4; }
        .amount-large { font-size: 26px; font-weight: 800; color: #111827; margin: 8px 0 4px 0; letter-spacing: -0.5px; }
        .amount-medium { font-size: 18px; font-weight: 700; color: #111827; margin-top: 6px; }
        .flex-row { display: flex; align-items: center; gap: 10px; }
        .flex-between { display: flex; align-items: center; justify-content: space-between; }
        .divider-line { height: 1px; background: linear-gradient(90deg, rgba(229,231,235,0.2) 0%, rgba(229,231,235,1) 15%, rgba(229,231,235,1) 85%, rgba(229,231,235,0.2) 100%); margin: 14px 0; border: none; }
        .mt-3 { margin-top: 12px; }
        .illus-avatar { width: 34px; height: 34px; border-radius: 50%; background: linear-gradient(135deg, #3B82F6, #1D4ED8); color: white; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; letter-spacing: 0.5px; box-shadow: 0 4px 8px rgba(37, 99, 235, 0.3); }
        .thumbnail-row { display: flex; gap: 8px; margin: 10px 0; }
        .thumb { width: 40px; height: 40px; border-radius: 8px; background: #F3F4F6; border: 1px solid #E5E7EB; display: flex; align-items: center; justify-content: center; overflow: hidden; }
        .thumb img { width: 100%; height: 100%; object-fit: cover; }
        .illus-badge { display: inline-flex; align-items: center; gap: 5px; padding: 4px 10px; border-radius: 99px; font-size: 10px; font-weight: 700; width: fit-content; line-height: 1.2; }
        .badge-green { background: #ECFDF5; color: #059669; border: 1px solid #A7F3D0; }
        .badge-amber { background: #FFFBEB; color: #D97706; border: 1px solid #FDE68A; }
        .badge-blue { background: #EFF6FF; color: #2563EB; border: 1px solid #BFDBFE; }
        .status-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 2px rgba(255,255,255,0.5); }
        .deco { position: absolute; z-index: 4; opacity: 0.8; animation: floatIcon1 8s ease-in-out infinite alternate; }
        .deco-star { top: 22%; left: 75%; animation-name: floatIcon2; animation-duration: 6s; }
        .deco-plus { top: 38%; left: 35%; opacity: 0.6; }
        .deco-circle { top: 75%; left: 10%; width: 8px; height: 8px; border-radius: 50%; background: #FDE68A; animation-name: floatIcon2; }
        .deco-diamond { top: 10%; left: 25%; opacity: 0.5; }

        /* STAT CARDS */
        .stats-row { display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:28px; }
        .stat-card { display:flex;align-items:center;gap:14px;text-align:left; background:var(--white);border:1px solid var(--border);border-radius:16px; box-shadow:var(--shadow-card);padding:18px 20px;cursor:pointer; transition:transform .15s ease, box-shadow .15s ease, border-color .15s ease; }
        .stat-card:hover { transform:translateY(-2px);box-shadow:0 6px 14px rgba(20,22,30,.06),0 16px 36px rgba(20,22,30,.08); }
        .stat-icon { width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex:none; }
        .stat-icon svg { width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:2.2; }
        .stat-card.amber .stat-icon { background:var(--amber-bg);color:var(--amber-text); }
        .stat-card.blue .stat-icon { background:var(--blue-50);color:var(--blue); }
        .stat-card.green .stat-icon { background:var(--green-bg);color:var(--green-text); }
        .stat-card.red .stat-icon { background:var(--red-bg);color:var(--red-text); }
        .stat-card.amber:hover { border-color:var(--amber-text); }
        .stat-card.blue:hover { border-color:var(--blue); }
        .stat-card.green:hover { border-color:var(--green-text); }
        .stat-card.red:hover { border-color:var(--red-text); }
        .stat-text { display:flex;flex-direction:column;gap:1px;min-width:0; }
        .stat-label { font-size:11.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-secondary); }
        .stat-num { font-size:21px;font-weight:800;line-height:1.3;color:var(--ink); }
        .stat-card.amber .stat-num { color:var(--amber-text); }
        .stat-card.blue .stat-num { color:var(--blue); }
        .stat-card.green .stat-num { color:var(--green-text); }
        .stat-card.red .stat-num { color:var(--red-text); }
        .stat-cap { font-size:12.5px;color:var(--ink-muted); }

        /* Custom top bar */
        .commissions-page .page-head { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 20px; }
        .commissions-page .page-head h1 { margin: 0 0 4px; font-size: 26px; font-weight: 700; }
        .commissions-page .page-head p { margin: 0; font-size: 14px; color: var(--ink-secondary); }
        .commissions-page .btn-ghost { background: transparent; border: 1px solid var(--border); display: inline-flex; align-items: center; gap: 6px; border-radius: 10px; padding: 10px 16px; font-size: 14px; font-weight: 600; color: var(--ink); cursor: pointer; }
        .commissions-page .btn-ghost:hover { background: #F9FAFB; }

        /* Tabs */
        .commissions-page .tabs-container { background: #f1f2f5; padding: 4px; border-radius: 11px; display: flex; gap: 4px; width: fit-content;}
        .commissions-page .tab { display: flex; align-items: center; gap: 8px; padding: 7px 12px; font-size: 13px; font-weight: 600; color: var(--ink-secondary); border-radius: 8px; cursor: pointer; transition: all .15s ease; border: none; background: transparent; }
        .commissions-page .tab.active { background: #fff; color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.08); }
        .commissions-page .tab:hover:not(.active) { background: #F9FAFB; }
        .commissions-page .tab-badge { display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;border-radius:999px;font-size:10.5px;font-weight:800; }
        .commissions-page .tab.active .tab-badge { background: #D1D5DB; color: #4B5563; }
        .commissions-page .tab-badge.amber { background: var(--amber-bg); color: var(--amber-text); }
        .commissions-page .tab-badge.blue { background: var(--blue-50); color: var(--blue); }
        .commissions-page .tab-badge.green { background: var(--green-bg); color: var(--green-text); }
        .commissions-page .tab-badge.red { background: var(--red-bg); color: var(--red-text); }

        /* List Wrapper */
        .commissions-page .panel { background: #fff; border-radius: 20px; box-shadow: var(--shadow-card); padding: 26px 28px 12px; }
        .commissions-page .panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
        .commissions-page .panel-head h3 { font-size: 17px; font-weight: 700; margin: 0; }

        /* Creator Group */
        .commissions-page .creator-group { border-bottom: 1px solid var(--border); }
        .commissions-page .creator-group:last-child { border-bottom: none; }
        .commissions-page .creator-header { padding: 16px 10px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; transition: background .15s; }
        .commissions-page .creator-header:hover { background: #F9FAFB; }
        .commissions-page .creator-header-left { display: flex; align-items: flex-start; gap: 10px; }
        .commissions-page .creator-info h3 { margin: 0; font-size: 14.5px; font-weight: 700; }
        .commissions-page .creator-info p { margin: 2px 0 0; font-size: 13px; color: var(--ink-secondary); }
        .commissions-page .creator-header-right { display: flex; align-items: center; gap: 16px; }
        .commissions-page .creator-total { font-size: 14px; font-weight: 700; }

        /* Custom Checkbox */
        .commissions-page .custom-checkbox { width: 16px; height: 16px; border: 1px solid var(--ink-muted); border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; margin-top: 2px; background: #fff; }
        .commissions-page .custom-checkbox.checked { background: var(--blue); border-color: var(--blue); color: #fff; }
        .commissions-page .custom-checkbox svg { width: 10px; height: 10px; opacity: 0; }
        .commissions-page .custom-checkbox.checked svg { opacity: 1; }

        /* Buttons */
        .commissions-page .btn-dark { background: var(--ink); color: #fff; border: none; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 8px; cursor: pointer; font-family: inherit; transition: all .15s; }
        .commissions-page .btn-dark:hover { background: #202635; }
        .commissions-page .btn-reject { border-color: #FCCFE8; color: #BE185D; padding: 4px 10px; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border); background: #fff; border-radius: 8px; cursor: pointer; transition: all .15s;}
        .commissions-page .btn-reject:hover { background: #FDF2F8; border-color: #FBCFE8; }
        .commissions-page .btn-approve { border: 1px solid var(--border); background: #fff; color: var(--ink); padding: 4px 10px; font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; cursor: pointer; font-family: inherit; transition: all .15s; }
        .commissions-page .btn-approve:hover { background: #F7F9FC; border-color: #C7CFDC; }
        .commissions-page button[disabled] { opacity: .55; cursor: progress; }

        /* Commission Rows */
        .commissions-page .commission-row { padding: 14px 10px 14px 44px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; transition: background .15s; background: #fafbfc; border: 1px solid var(--border); border-radius: 10px; margin-bottom: 8px; }
        .commissions-page .commission-row:hover { background: #f4f5f7; }
        .commissions-page .row-left { display: flex; align-items: flex-start; gap: 14px; }
        .commissions-page .row-info { display: flex; flex-direction: column; gap: 2px; }
        .commissions-page .row-order { font-size: 13px; color: var(--ink-secondary); }
        .commissions-page .row-meta { font-size: 12.5px; color: var(--ink-secondary); }
        .commissions-page .row-right { display: flex; align-items: center; gap: 24px; }
        .commissions-page .row-amount-stack { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
        .commissions-page .row-amount { font-size: 13px; font-weight: 700; }

        /* Badges */
        .commissions-page .status-badge { display: inline-flex; align-items: center; gap: 4px; font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 999px; text-transform: capitalize; border: 1px solid transparent; }
        .commissions-page .badge-pending { background: var(--amber-bg); color: var(--amber-text); border-color: var(--amber-border); }
        .commissions-page .badge-approved { background: var(--blue-50); color: var(--blue); }
        .commissions-page .badge-paid { background: var(--green-bg); color: var(--green-text); }
        .commissions-page .badge-rejected { background: var(--red-bg); color: var(--red-text); }

        /* Details Table in Modal */
        .details-section { margin-bottom: 24px; }
        .details-section-title { font-size: 11px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #E5E7EB; padding-bottom: 6px; margin-bottom: 12px; }
        .details-row { display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 8px; color: #374151; }
        .details-row.total { font-weight: 700; border-top: 1px solid #E5E7EB; padding-top: 8px; margin-top: 8px; color: var(--ink); }

        /* Timeline & Lifecycle Modal (Ported from test.html) */
        .commissions-page .btn-lifecycle {
          background: linear-gradient(135deg, #EFF6FF 0%, #DBEAFE 100%);
          border: 1px solid #BFDBFE;
          color: #1D4ED8;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          border-radius: 10px;
          padding: 10px 16px;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.15s ease;
          box-shadow: 0 1px 2px rgba(29,78,216,0.08);
        }
        .commissions-page .btn-lifecycle:hover {
          background: linear-gradient(135deg, #DBEAFE 0%, #BFDBFE 100%);
          border-color: #93C5FD;
          transform: translateY(-1px);
          box-shadow: 0 4px 10px rgba(29,78,216,0.15);
        }

        .summary-box {
          background: #ffffff;
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 16px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 24px;
          box-shadow: 0 1px 2px rgba(0,0,0,0.02);
        }
        .summary-section { display: flex; flex-direction: column; gap: 4px; }
        .summary-section.right { text-align: right; align-items: flex-end; }
        .summary-label { font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #9ca3af; }
        .summary-value { display: flex; align-items: center; gap: 6px; font-size: 0.9375rem; font-weight: 600; color: #111827; }
        .summary-amount { font-size: 1.15rem; font-weight: 700; color: #059669; background: #ecfdf5; padding: 4px 10px; border-radius: 8px; border: 1px solid #a7f3d0; }
        .summary-amount-blue { font-size: 1.15rem; font-weight: 700; color: #2563eb; background: #eff6ff; padding: 4px 10px; border-radius: 8px; border: 1px solid #bfdbfe; }
        .summary-divider { width: 1px; height: 32px; background: #e5e7eb; }

        .lifecycle-timeline { position: relative; padding-left: 12px; margin-top: 12px; }
        .lifecycle-timeline::before {
          content: '';
          position: absolute;
          left: 30px;
          top: 20px;
          bottom: 40px;
          width: 2px;
          background: #e5e7eb;
          z-index: 1;
        }

        .timeline-item { position: relative; display: flex; gap: 16px; margin-bottom: 16px; z-index: 2; }
        .timeline-item:last-child { margin-bottom: 0; }
        .timeline-icon {
          width: 38px;
          height: 38px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          background: #ffffff;
          border: 2px solid;
          box-shadow: 0 0 0 4px #ffffff;
        }
        .timeline-icon svg { width: 18px; height: 18px; }

        .status-pending .timeline-icon { border-color: #d97706; color: #d97706; background: #fffbeb; }
        .status-approved .timeline-icon { border-color: #4f46e5; color: #4f46e5; background: #eef2ff; }
        .status-payout .timeline-icon { border-color: #9333ea; color: #9333ea; background: #faf5ff; }
        .status-paid .timeline-icon { border-color: #059669; color: #059669; background: #ecfdf5; }

        .status-pending .status-text { color: #d97706; }
        .status-approved .status-text { color: #4f46e5; }
        .status-payout .status-text { color: #9333ea; }
        .status-paid .status-text { color: #059669; }

        .timeline-card {
          flex-grow: 1;
          background: #ffffff;
          border: 1px solid #e5e7eb;
          border-radius: 12px;
          padding: 16px;
          box-shadow: 0 1px 3px rgba(0,0,0,0.02);
          transition: all 0.2s ease;
        }
        .timeline-card:hover { box-shadow: 0 4px 10px rgba(0,0,0,0.05); border-color: #d1d5db; }
        .card-header { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 6px; }
        .stage-title-wrap { display: flex; flex-direction: column; gap: 2px; }
        .stage-title { display: flex; align-items: center; gap: 8px; }
        .stage-num { font-size: 0.75rem; font-weight: 700; color: #9ca3af; letter-spacing: 0.05em; }
        .stage-title h3 { font-size: 0.9rem; font-weight: 700; color: #111827; text-transform: uppercase; letter-spacing: 0.02em; margin: 0; }
        .status-text { font-size: 0.8rem; font-weight: 600; }
        .meaning-text { font-size: 0.85rem; color: #6b7280; line-height: 1.5; margin-top: 4px; }

        .product-snippet { display: flex; align-items: center; gap: 12px; margin-top: 14px; padding: 10px 12px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 10px; }
        .product-snippet img { width: 44px; height: 44px; border-radius: 8px; object-fit: cover; border: 1px solid rgba(0,0,0,0.08); }
        .product-info { display: flex; flex-direction: column; gap: 2px; }
        .product-affiliate { font-size: 0.75rem; font-weight: 700; color: #2563EB; }
        .product-name { font-size: 0.85rem; font-weight: 600; color: #111827; }
        .product-meta { font-size: 0.75rem; color: #6b7280; }

        .transition-label { margin: 10px 0 10px 58px; font-size: 0.72rem; font-weight: 700; color: #6b7280; display: flex; align-items: center; gap: 6px; letter-spacing: 0.05em; text-transform: uppercase; position: relative; z-index: 2; }
        .transition-label svg { width: 14px; height: 14px; color: #9ca3af; }
      `}</style>

      <div className="commissions-page">
        <div className="page-inner">
          
          <div className="page-head">
            <div>
              <h1>Commissions</h1>
              <p>Review creator earnings and approve commissions</p>
            </div>
            <div style={{ display: 'flex', gap: '12px' }}>
              <button className="btn-lifecycle" onClick={() => setShowLifecycle(true)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                Commission Lifecycle
              </button>
              <button className="btn-ghost" onClick={exportCSV}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                Export file
              </button>
            </div>
          </div>

          <div className="saas-illustration-container">
            {/* Background Decor */}
            <div className="bg-dot-pattern"></div>
            <div className="bg-glow-orb"></div>
            
            {/* Decorative organic background curves */}
            <svg className="bg-curves" viewBox="0 0 800 420" preserveAspectRatio="xMidYMid slice">
                <path d="M -50 80 C 150 50, 200 300, 420 200 C 600 120, 700 350, 900 250" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="2" strokeDasharray="6 8" strokeLinecap="round"/>
                <path d="M 0 300 C 250 350, 300 100, 500 150 C 650 180, 750 80, 900 100" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="1.5" strokeDasharray="4 6"/>
            </svg>

            {/* Floating Decor Shapes */}
            <svg className="deco deco-star" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2L14.3162 9.13063H21.8155L15.7496 13.5387L18.0658 20.6694L12 16.2613L5.93417 20.6694L8.25036 13.5387L2.18446 9.13063H9.68378L12 2Z" fill="#FCD34D"/>
            </svg>
            <svg className="deco deco-plus" width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M8 2V14M2 8H14" stroke="#60A5FA" strokeWidth="2.5" strokeLinecap="round"/>
            </svg>
            <svg className="deco deco-diamond" width="14" height="14" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <rect x="12" y="2" width="14.1421" height="14.1421" transform="rotate(45 12 2)" fill="#A78BFA"/>
            </svg>
            <div className="deco deco-circle"></div>

            {/* Creator Card */}
            <div className="card-wrapper wrap-creator">
                <div className="float-inner">
                    <div className="ui-card">
                        <div className="flex-row">
                            <div className="illus-avatar">SJ</div>
                            <div>
                                <div className="text-tiny">Creator</div>
                                <div className="text-medium">Sarah Jenkins</div>
                            </div>
                        </div>
                        <div className="text-sub mt-3">Creator Program · Referral</div>
                        <div className="illus-badge badge-green mt-3">
                            <div className="status-dot"></div> Active referral
                        </div>
                    </div>
                </div>
            </div>

            {/* Order Card */}
            <div className="card-wrapper wrap-order">
                <div className="float-inner">
                    <div className="ui-card">
                        <div className="flex-between">
                            <div className="text-tiny">Referred order</div>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>
                        </div>
                        <div className="text-medium mt-3">Order #1762</div>
                        <div className="text-sub">Order value · {formatMoney(786)}</div>
                        <div className="thumbnail-row">
                            <div className="thumb">
                                <img src="/placeholder1.avif" alt="Product 1" />
                            </div>
                            <div className="thumb">
                                <img src="/placeholder2.avif" alt="Product 2" />
                            </div>
                        </div>
                        <div className="illus-badge badge-green mt-3">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> Completed
                        </div>
                    </div>
                </div>
            </div>

            {/* MAIN Commission Card */}
            <div className="card-wrapper wrap-commission">
                <div className="float-inner">
                    <div className="ui-card main-card">
                        <div className="flex-between">
                            <div className="text-tiny" style={{ color: "#3B82F6" }}>Commission</div>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="#3B82F6" stroke="#3B82F6" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.2"><path d="M12 2L15 8.5L22 9.5L17 14.5L18.5 21.5L12 18L5.5 21.5L7 14.5L2 9.5L9 8.5L12 2Z"></path></svg>
                        </div>
                        <div className="amount-large">{formatMoney(102.17)}</div>
                        <div className="text-sub">13% of commissionable order value</div>
                        
                        <div className="divider-line"></div>
                        
                        <div className="flex-between">
                            <div className="text-tiny" style={{ margin: 0 }}>Status:</div>
                            <div className="illus-badge badge-amber">
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg> 
                                Pending review
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Payout Card */}
            <div className="card-wrapper wrap-payout">
                <div className="float-inner">
                    <div className="ui-card small-card">
                        <div className="text-tiny">Next step</div>
                        <div className="text-medium">Creator payout</div>
                        <div className="amount-medium">{formatMoney(180)}</div>
                        
                        <div className="illus-badge badge-blue mt-3">
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> 
                            Ready after approval
                        </div>
                    </div>
                </div>
            </div>

          </div>

          <div className="stats-row">
            <button className="stat-card amber" onClick={() => changeTab('PENDING')} style={{ borderColor: status === 'PENDING' ? 'var(--amber-text)' : '' }}>
              <div className="stat-icon">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
              </div>
              <div className="stat-text">
                <span className="stat-label">Pending</span>
                <span className="stat-num">{formatMoney(totals['PENDING']?.amount || 0)}</span>
                <span className="stat-cap">{totals['PENDING']?.count || 0} commissions</span>
              </div>
            </button>
            <button className="stat-card blue" onClick={() => changeTab('APPROVED')} style={{ borderColor: status === 'APPROVED' ? 'var(--blue)' : '' }}>
              <div className="stat-icon">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.3 2.3L16 10"/></svg>
              </div>
              <div className="stat-text">
                <span className="stat-label">Approved</span>
                <span className="stat-num">{formatMoney(totals['APPROVED']?.amount || 0)}</span>
                <span className="stat-cap">{totals['APPROVED']?.count || 0} commissions</span>
              </div>
            </button>
            <button className="stat-card green" onClick={() => changeTab('PAID')} style={{ borderColor: status === 'PAID' ? 'var(--green-text)' : '' }}>
              <div className="stat-icon">
                <svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10.5h18"/><path d="M7 15h4"/></svg>
              </div>
              <div className="stat-text">
                <span className="stat-label">Paid</span>
                <span className="stat-num">{formatMoney(totals['PAID']?.amount || 0)}</span>
                <span className="stat-cap">{totals['PAID']?.count || 0} commissions</span>
              </div>
            </button>
            <button className="stat-card red" onClick={() => changeTab('REJECTED')} style={{ borderColor: status === 'REJECTED' ? 'var(--red-text)' : '' }}>
              <div className="stat-icon">
                <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
              </div>
              <div className="stat-text">
                <span className="stat-label">Rejected</span>
                <span className="stat-num">{formatMoney(totals['REJECTED']?.amount || 0)}</span>
                <span className="stat-cap">{totals['REJECTED']?.count || 0} commissions</span>
              </div>
            </button>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h3>Commission list</h3>
            </div>

            <div className="tabs-container" style={{ marginBottom: '16px' }}>
              {tabs.map((tab) => {
                let badgeClass = 'amber';
                if (tab.id === 'APPROVED') badgeClass = 'blue';
                if (tab.id === 'PAID') badgeClass = 'green';
                if (tab.id === 'REJECTED') badgeClass = 'red';
                
                return (
                  <button 
                    key={tab.id}
                    className={`tab ${status === tab.id ? 'active' : ''}`}
                    onClick={() => changeTab(tab.id)}
                  >
                    {tab.content} <span className={`tab-badge ${badgeClass}`}>{tab.badge}</span>
                  </button>
                )
              })}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', border: '1px solid var(--border)', borderRadius: '10px', padding: '9px 12px', color: 'var(--ink-muted)', fontSize: '13px', maxWidth: '280px', marginBottom: '16px' }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
              <input 
                type="text" 
                placeholder="Search creators, orders..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{ border: 'none', outline: 'none', background: 'transparent', width: '100%', color: 'var(--ink)', fontSize: '13px' }}
              />
            </div>

            <div className="list-wrapper" style={{ boxShadow: 'none', border: 'none' }}>
              {filteredCreators.length === 0 ? (
                <div style={{ padding: '60px', textAlign: 'center', color: 'var(--muted)' }}>
                  <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ margin: '0 auto 16px', opacity: 0.5 }}>
                    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line>
                  </svg>
                  <div style={{ fontSize: '15px', fontWeight: '600', color: 'var(--ink)' }}>
                    {searchQuery ? "No matching commissions found" : emptyHeading}
                  </div>
                  <div style={{ fontSize: '13.5px', marginTop: '4px' }}>
                    {searchQuery ? `We couldn't find any results for "${searchQuery}".` : emptySubheading}
                  </div>
                </div>
              ) : (
                filteredCreators.map((group) => {
                  const ids = group.commissions.map((c) => c.id);
                  const selectedInGroup = ids.filter(id => selected.has(id));
                  const allSelected = selectedInGroup.length === ids.length && ids.length > 0;
                  const isCollapsed = collapsedGroups.has(group.creatorId);
                  
                  return (
                    <div key={group.creatorId} className="creator-group">
                      <div className="creator-header" onClick={() => toggleCollapse(group.creatorId)}>
                        <div className="creator-header-left">
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '20px', height: '20px', color: 'var(--muted)', transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }}>
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
                          </div>
                          {(status === "PENDING" || status === "APPROVED") && (
                            <div 
                              className={`custom-checkbox ${allSelected ? 'checked' : ''}`} 
                              onClick={(e) => toggleCreator(group, e)}
                            >
                              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                            </div>
                          )}
                          <div className="creator-info">
                            <h3>{group.name}</h3>
                            <p>{group.commissions.length} {status.toLowerCase()} commission{group.commissions.length === 1 ? '' : 's'} · {group.programName} · <code>{group.referralCode}</code></p>
                          </div>
                        </div>
                        <div className="creator-header-right">
                          <div className="creator-total">{formatMoney(group.total)}</div>
                          
                          {status === "PENDING" && (
                            <button 
                              className="btn-dark" 
                              disabled={isBusy}
                              onClick={(e) => { e.stopPropagation(); run("approve", selectedInGroup.length > 0 ? selectedInGroup : ids); }}
                            >
                              {isBusy
                                ? "Working…"
                                : selectedInGroup.length > 0 && selectedInGroup.length < ids.length
                                  ? `Approve ${selectedInGroup.length}`
                                  : `Approve all`}
                            </button>
                          )}
                          
                          {status === "IN_PAYOUT" && (
                            <a className="btn-approve" href="/app/payouts" onClick={(e) => e.stopPropagation()}>
                              View payout
                            </a>
                          )}

                          {status === "APPROVED" && (
                            <button 
                              className="btn-dark" 
                              disabled={isBusy}
                              onClick={(e) => { e.stopPropagation(); run("payout", selectedInGroup.length > 0 ? selectedInGroup : ids, { creatorId: group.creatorId }); }}
                            >
                              {isBusy
                                ? "Working…"
                                : selectedInGroup.length > 0 && selectedInGroup.length < ids.length
                                  ? `Create payout (${selectedInGroup.length})`
                                  : `Create payout (All)`}
                            </button>
                          )}
                        </div>
                      </div>

                      {!isCollapsed && group.commissions.map((commission) => (
                        <div key={commission.id} className="commission-row" onClick={() => setDetailsCommission({ creator: group, commission })}>
                          <div className="row-left">
                            {(status === "PENDING" || status === "APPROVED") && (
                              <div 
                                className={`custom-checkbox ${selected.has(commission.id) ? 'checked' : ''}`} 
                                onClick={(e) => toggle(commission.id, e)}
                              >
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
                              </div>
                            )}
                            <div className="row-info">
                              <div className="row-order">{commission.orderNumber ? `Order ${commission.orderNumber}` : '—'}</div>
                              <div className="row-meta">
                                {commission.createdAt ? new Date(commission.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}
                              </div>
                              
                              {status === "PAID" && commission.payoutId && (
                                <div className="row-meta" style={{ color: 'var(--green-text)', marginTop: '2px', fontWeight: '500' }}>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', marginRight: '4px', verticalAlign: '-2px' }}><rect x="2" y="6" width="20" height="12" rx="2"></rect><path d="M12 12h.01"></path><path d="M17 12h.01"></path><path d="M7 12h.01"></path></svg>
                                  Payout {commission.payoutId}
                                </div>
                              )}

                              {commission.rejectionReason && (
                                <div className="row-meta" style={{ color: '#9D174D', marginTop: '2px' }}>
                                  Reason: {commission.rejectionReason}
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="row-right">
                            <div className="row-amount-stack">
                              <div className="row-amount" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                {commission.adjusted && (
                                  <span style={{ color: 'var(--muted)', textDecoration: 'line-through', fontSize: '12px', fontWeight: '500' }}>
                                    {formatMoney(commission.originalAmount)}
                                  </span>
                                )}
                                {formatMoney(commission.amount)}
                                {commission.adjusted && (
                                  <div title="Commission was adjusted (e.g., partial refund)" style={{ display: 'flex', color: 'var(--amber-600)' }}>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                                  </div>
                                )}
                              </div>
                              
                              <div className={`status-badge badge-${commission.status.toLowerCase()}`}>
                                {commission.payoutId
                                  ? "In payout"
                                  : commission.status.charAt(0) + commission.status.slice(1).toLowerCase()}
                              </div>
                            </div>
                            
                            {status === "PENDING" && (
                              <button
                                className="btn-approve"
                                disabled={isBusy}
                                onClick={(e) => { e.stopPropagation(); run("approve", [commission.id]); }}
                              >
                                {isBusy ? "Working…" : "Approve"}
                              </button>
                            )}

                            {(status === "PENDING" || status === "APPROVED") && !commission.payoutId && (
                              <button 
                                className="btn-reject" 
                                disabled={isBusy}
                                onClick={(e) => { e.stopPropagation(); setRejecting([commission.id]); }}
                              >
                                Reject
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Reject Modal */}
      <Modal
        open={Boolean(rejecting)}
        onClose={() => { setRejecting(null); setReason("Order cancelled"); setNotes(""); }}
        title={`Reject ${rejecting?.length === 1 ? "commission" : `${rejecting?.length} commissions`}`}
        primaryAction={{
          content: "Reject commission",
          destructive: true,
          disabled: !reason || isBusy,
          onAction: () => {
            run("reject", rejecting, { reason, notes });
            setRejecting(null);
            setReason("Order cancelled");
            setNotes("");
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => { setRejecting(null); setReason("Order cancelled"); setNotes(""); } },
        ]}
      >
        <Modal.Section>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <p style={{ margin: 0, color: 'var(--muted)', fontSize: '14px' }}>
              The creator keeps credit for generating the order — only their entitlement to be paid
              for it is withdrawn.
            </p>
            <Select
              label="Reason"
              options={REJECTION_REASONS}
              value={reason}
              onChange={setReason}
            />
            <TextField
              label="Optional notes"
              value={notes}
              onChange={setNotes}
              autoComplete="off"
              multiline={3}
              placeholder="Provide more context (e.g. partial refund, duplicate referral)..."
            />
          </div>
        </Modal.Section>
      </Modal>

      {/* Commission Details Drawer/Modal */}
      <Modal
        open={Boolean(detailsCommission)}
        onClose={() => setDetailsCommission(null)}
        title={detailsCommission ? `Commission for ${detailsCommission.commission.orderNumber}` : "Commission details"}
      >
        <Modal.Section>
          {detailsCommission && (
            <div>
              <div style={{ marginBottom: '20px', fontSize: '14px' }}>
                <div style={{ fontWeight: '600' }}>{detailsCommission.creator.name}</div>
                <div style={{ color: 'var(--muted)' }}>{detailsCommission.creator.programName}</div>
              </div>

              <div className="details-section">
                <div className="details-section-title">Order</div>
                <div className="details-row">
                  <span>Order ID</span>
                  <span>{detailsCommission.commission.orderNumber || "—"}</span>
                </div>
                <div className="details-row total">
                  <span>Order value</span>
                  <span>{formatMoney(detailsCommission.commission.orderAmount)}</span>
                </div>
              </div>

              <div className="details-section">
                <div className="details-section-title">Commission</div>
                <div className="details-row">
                  <span>Status</span>
                  <span style={{textTransform: 'capitalize'}}>{detailsCommission.commission.status === "APPROVED" ? "Ready for payout" : detailsCommission.commission.status.toLowerCase()}</span>
                </div>
                {detailsCommission.commission.adjusted && (
                  <div className="details-row" style={{ color: 'var(--amber-600)' }}>
                    <span>Original amount</span>
                    <span>{formatMoney(detailsCommission.commission.originalAmount)}</span>
                  </div>
                )}
                <div className="details-row total">
                  <span>{detailsCommission.commission.adjusted ? "Final commission owed" : "Commission owed"}</span>
                  <span>{formatMoney(detailsCommission.commission.amount)}</span>
                </div>
              </div>
              
              <div className="details-section">
                <div className="details-section-title">Calculation Details</div>
                <div className="details-row">
                  <span>The final amount calculated for this referral based on active program rules.</span>
                </div>
              </div>

              {detailsCommission.commission.orderId && (
                <div style={{ marginTop: '24px' }}>
                  <a 
                    href={`shopify:admin/orders/${detailsCommission.commission.orderId.split('/').pop()}`}
                    target="_blank"
                    style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '100%', padding: '8px', background: '#F4F6F8', border: '1px solid var(--border)', borderRadius: '8px', color: 'var(--ink)', textDecoration: 'none', fontWeight: '600', fontSize: '13px', transition: 'background 0.15s' }}
                    onMouseEnter={(e) => e.target.style.background = '#E7EAF1'}
                    onMouseLeave={(e) => e.target.style.background = '#F4F6F8'}
                  >
                    View Shopify order
                  </a>
                </div>
              )}

            </div>
          )}
        </Modal.Section>
      </Modal>

      <Modal open={showLifecycle} onClose={() => setShowLifecycle(false)} title="Commission Lifecycle">
        <Modal.Section>
          <div className="commissions-page" style={{ margin: 0, padding: 0, minHeight: 'auto', background: 'transparent' }}>
            
            {/* Summary Box */}
            <div className="summary-box">
              <div className="summary-section">
                <span className="summary-label">Source Order</span>
                <div className="summary-value">
                  <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"></path></svg>
                  #ORD-1762
                </div>
              </div>
              <div className="summary-divider"></div>
              <div className="summary-section">
                <span className="summary-label">Order Total</span>
                <div className="summary-amount-blue">
                  {formatMoney(786)}
                </div>
              </div>
              <div className="summary-divider"></div>
              <div className="summary-section right">
                <span className="summary-label">Total Commission</span>
                <div className="summary-amount">
                  {formatMoney(102.17)}
                </div>
              </div>
            </div>

            {/* Timeline */}
            <div className="lifecycle-timeline">
              
              {/* Stage 1: Pending */}
              <div className="timeline-item status-pending">
                <div className="timeline-icon">
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                </div>
                <div className="timeline-card">
                  <div className="card-header">
                    <div className="stage-title-wrap">
                      <div className="stage-title">
                        <span className="stage-num">01</span>
                        <h3>Commission Pending</h3>
                      </div>
                      <div className="status-text">Waiting for review</div>
                    </div>
                  </div>
                  <div className="meaning-text">An order was successfully placed via an affiliate referral link. The commission is recorded and pending standard review.</div>
                  
                  {/* Enhanced Product Snippet with Creator Attribution */}
                  <div className="product-snippet">
                    <img src="/placeholder1.avif" alt="Product" />
                    <div className="product-info">
                      <span className="product-affiliate">Referred by Sarah Jenkins (SARAHQ7X2)</span>
                      <span className="product-name">Premium Wireless Headphones</span>
                      <span className="product-meta">Order Total: {formatMoney(786)} • Qty: 1</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Transition */}
              <div className="transition-label">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path></svg>
                Approve
              </div>

              {/* Stage 2: Approved */}
              <div className="timeline-item status-approved">
                <div className="timeline-icon">
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                </div>
                <div className="timeline-card">
                  <div className="card-header">
                    <div className="stage-title-wrap">
                      <div className="stage-title">
                        <span className="stage-num">02</span>
                        <h3>Commission Approved</h3>
                      </div>
                      <div className="status-text">Approved for payout</div>
                    </div>
                  </div>
                  <div className="meaning-text">The merchant or return window passed. Commission is confirmed and ready to be attached to a creator payout.</div>
                </div>
              </div>

              {/* Transition */}
              <div className="transition-label">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path></svg>
                Create Payout
              </div>

              {/* Stage 3: Payout Created */}
              <div className="timeline-item status-payout">
                <div className="timeline-icon">
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"></path></svg>
                </div>
                <div className="timeline-card">
                  <div className="card-header">
                    <div className="stage-title-wrap">
                      <div className="stage-title">
                        <span className="stage-num">03</span>
                        <h3>Payout Created</h3>
                      </div>
                      <div className="status-text">Queued for processing</div>
                    </div>
                  </div>
                  <div className="meaning-text">Payout batch <strong>#PAY-5521</strong> has been created and prepared for settlement.</div>
                </div>
              </div>

              {/* Transition */}
              <div className="transition-label">
                <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 14l-7 7m0 0l-7-7m7 7V3"></path></svg>
                Transfer Funds
              </div>

              {/* Stage 4: Paid */}
              <div className="timeline-item status-paid">
                <div className="timeline-icon">
                  <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138z"></path></svg>
                </div>
                <div className="timeline-card">
                  <div className="card-header">
                    <div className="stage-title-wrap">
                      <div className="stage-title">
                        <span className="stage-num">04</span>
                        <h3>Commission Paid</h3>
                      </div>
                      <div className="status-text">Transaction completed</div>
                    </div>
                  </div>
                  <div className="meaning-text">The payout funds were successfully transferred to the creator's payout account.</div>
                </div>
              </div>

            </div>
          </div>
        </Modal.Section>
      </Modal>

    </Page>
  );
}
