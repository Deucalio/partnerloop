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
import { COMMISSION_TABS } from "../commission-tabs";

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const status = COMMISSION_TABS.some((tab) => tab.id === url.searchParams.get("status"))
    ? url.searchParams.get("status")
    : "PENDING";

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

  const isBusy = navigation.state === "submitting";

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
          --blue-900: #1E3A8A;
          --blue-800: #1D4ED8;
          --blue-600: #2563EB;
          --blue-tint: #EEF4FF;
          --amber-600: #F59E0B;
          --amber-400: #FFB648;
          --amber-tint: #FFF6E5;
          --amber-text: #92620A;
          --ink: #161A25;
          --muted: #6B7280;
          --muted-2: #8A93A3;
          --green-bg: #DEFBE8;
          --green-text: #0F8A4B;
          --border: #E4E8F0;
          --border-soft: #EBEEF4;
        }

        .commissions-page * { box-sizing: border-box; }
        .commissions-page { font-family: 'Inter', system-ui, sans-serif; background: #F0F2F6; color: var(--ink); margin: -1rem; min-height: 100vh; }
        .commissions-page .page-inner { max-width: 1280px; margin: 0 auto; padding: 24px 28px 70px; }

        /* Custom top bar */
        .commissions-page .header-row { display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 24px; }
        .commissions-page .header-left h1 { margin: 0; font-size: 20px; font-weight: 800; }
        .commissions-page .header-left p { margin: 4px 0 0; font-size: 13px; color: var(--muted); }
        .commissions-page .header-right { text-align: right; }
        .commissions-page .header-right h2 { margin: 0; font-size: 18px; font-weight: 800; }
        .commissions-page .header-right p { margin: 2px 0 0; font-size: 12.5px; color: var(--muted); }

        /* Tabs */
        .commissions-page .tabs-container { background: #fff; border: 1px solid var(--border-soft); border-radius: 12px; box-shadow: 0 1px 2px rgba(20,30,60,.03); padding: 4px; display: flex; gap: 4px; width: fit-content;}
        .commissions-page .tab { display: flex; align-items: center; gap: 8px; padding: 8px 16px; font-size: 13.5px; font-weight: 600; color: var(--muted); border-radius: 8px; cursor: pointer; transition: all .15s ease; border: none; background: transparent; }
        .commissions-page .tab.active { background: #F4F6F8; color: var(--ink); }
        .commissions-page .tab:hover:not(.active) { background: #F9FAFB; }
        .commissions-page .tab-badge { font-size: 11px; font-weight: 700; background: #E7EAF1; color: #4B5563; padding: 2px 8px; border-radius: 100px; }
        .commissions-page .tab.active .tab-badge { background: #D1D5DB; }

        /* List Wrapper */
        .commissions-page .list-wrapper { background: #fff; border: 1px solid var(--border-soft); border-radius: 16px; box-shadow: 0 1px 2px rgba(20,30,60,.03); overflow: hidden; }

        /* Creator Group */
        .commissions-page .creator-group { border-bottom: 1px solid var(--border-soft); }
        .commissions-page .creator-group:last-child { border-bottom: none; }
        .commissions-page .creator-header { padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; cursor: pointer; transition: background .15s; }
        .commissions-page .creator-header:hover { background: #F9FAFB; }
        .commissions-page .creator-header-left { display: flex; align-items: flex-start; gap: 10px; }
        .commissions-page .creator-info h3 { margin: 0; font-size: 14.5px; font-weight: 700; }
        .commissions-page .creator-info p { margin: 2px 0 0; font-size: 13px; color: var(--muted); }
        .commissions-page .creator-header-right { display: flex; align-items: center; gap: 16px; }
        .commissions-page .creator-total { font-size: 14px; font-weight: 700; }

        /* Custom Checkbox */
        .commissions-page .custom-checkbox { width: 16px; height: 16px; border: 1px solid var(--muted-2); border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: center; margin-top: 2px; background: #fff; }
        .commissions-page .custom-checkbox.checked { background: var(--blue-800); border-color: var(--blue-800); color: #fff; }
        .commissions-page .custom-checkbox svg { width: 10px; height: 10px; opacity: 0; }
        .commissions-page .custom-checkbox.checked svg { opacity: 1; }

        /* Buttons */
        .commissions-page .btn { display: inline-flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; padding: 7px 14px; border-radius: 8px; cursor: pointer; font-family: inherit; border: 1px solid var(--border); background: #fff; color: #374151; transition: all .15s; }
        .commissions-page .btn:hover { background: #F9FAFB; border-color: #C7CFDC; }
        .commissions-page .btn-dark { background: var(--ink); color: #fff; border: none; }
        .commissions-page .btn-dark:hover { background: #202635; }
        .commissions-page .btn-reject { border-color: #FCCFE8; color: #BE185D; padding: 4px 10px; font-size: 12px; }
        .commissions-page .btn-reject:hover { background: #FDF2F8; border-color: #FBCFE8; }

        /* Commission Rows */
        .commissions-page .commission-row { padding: 14px 24px 14px 62px; border-top: 1px solid #F3F4F6; display: flex; align-items: center; justify-content: space-between; cursor: pointer; transition: background .15s; }
        .commissions-page .commission-row:hover { background: #F9FAFB; }
        .commissions-page .row-left { display: flex; align-items: flex-start; gap: 14px; }
        .commissions-page .row-info { display: flex; flex-direction: column; gap: 2px; }
        .commissions-page .row-order { font-size: 13.5px; font-weight: 600; color: var(--ink); }
        .commissions-page .row-meta { font-size: 12.5px; color: var(--muted); }
        .commissions-page .row-right { display: flex; align-items: center; gap: 24px; }
        .commissions-page .row-amount-stack { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
        .commissions-page .row-amount { font-size: 14px; font-weight: 700; }

        /* Badges */
        .commissions-page .status-badge { font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 100px; text-transform: capitalize; display: inline-block; text-align: center; }
        .commissions-page .badge-pending { background: var(--amber-tint); color: var(--amber-text); border: 1px solid #FBE3B0; }
        .commissions-page .badge-approved { background: var(--blue-tint-2); color: var(--blue-800); border: 1px solid #BFDBFE; }
        .commissions-page .badge-paid { background: var(--green-bg); color: var(--green-text); border: 1px solid #A7F3D0; }
        .commissions-page .badge-rejected { background: #FCE8F3; color: #9D174D; border: 1px solid #FBCFE8; }

        /* Details Table in Modal */
        .details-section { margin-bottom: 24px; }
        .details-section-title { font-size: 11px; font-weight: 700; color: #6B7280; text-transform: uppercase; letter-spacing: 0.05em; border-bottom: 1px solid #E5E7EB; padding-bottom: 6px; margin-bottom: 12px; }
        .details-row { display: flex; justify-content: space-between; font-size: 14px; margin-bottom: 8px; color: #374151; }
        .details-row.total { font-weight: 700; border-top: 1px solid #E5E7EB; padding-top: 8px; margin-top: 8px; color: var(--ink); }
      `}</style>

      <div className="commissions-page">
        <div className="page-inner">
          
          <div className="header-row">
            <div className="header-left">
              <h1>Commissions</h1>
              <p>Review what creators have earned, then group approved commissions into a payout.</p>
            </div>
            <div className="header-right">
              <h2>{formatMoney(total)}</h2>
              <p>{count} commissions {summaryText}</p>
            </div>
          </div>

          <div className="filters-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
            <div className="tabs-container" style={{ margin: 0 }}>
              {tabs.map((tab) => (
                <button 
                  key={tab.id}
                  className={`tab ${status === tab.id ? 'active' : ''}`}
                  onClick={() => changeTab(tab.id)}
                >
                  {tab.content} <span className="tab-badge">{tab.badge}</span>
                </button>
              ))}
            </div>
            
            <div style={{ display: 'flex', gap: '12px' }}>
              <div style={{ position: 'relative' }}>
                <div style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)', display: 'flex' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                </div>
                <input 
                  type="text" 
                  placeholder="Search creators, orders..." 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  style={{ padding: '8px 12px 8px 34px', borderRadius: '8px', border: '1px solid var(--border)', fontSize: '13px', width: '240px', outline: 'none' }}
                />
              </div>
              <button className="btn" onClick={exportCSV}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ marginRight: '6px' }}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
                Export
              </button>
            </div>
          </div>

          <div className="list-wrapper">
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
                            className="btn btn-dark" 
                            disabled={isBusy}
                            onClick={(e) => { e.stopPropagation(); run("approve", selectedInGroup.length > 0 ? selectedInGroup : ids); }}
                          >
                            {selectedInGroup.length > 0 && selectedInGroup.length < ids.length 
                              ? `Approve ${selectedInGroup.length}` 
                              : `Approve all`}
                          </button>
                        )}
                        
                        {status === "APPROVED" && (
                          <button 
                            className="btn btn-dark" 
                            disabled={isBusy}
                            onClick={(e) => { e.stopPropagation(); run("payout", selectedInGroup.length > 0 ? selectedInGroup : ids, { creatorId: group.creatorId }); }}
                          >
                            {selectedInGroup.length > 0 && selectedInGroup.length < ids.length 
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
                              <div className="row-meta" style={{ color: 'var(--blue-600)', marginTop: '2px', fontWeight: '500' }}>
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
                              {commission.status === "APPROVED" ? "Ready for payout" : commission.status.charAt(0) + commission.status.slice(1).toLowerCase()}
                            </div>
                          </div>
                          
                          {(status === "PENDING" || status === "APPROVED") && !commission.payoutId && (
                            <button 
                              className="btn btn-reject" 
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
    </Page>
  );
}
