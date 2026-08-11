import { Page, Modal, Button, Tooltip } from "@shopify/polaris";
import { Form, useLoaderData, useSubmit, useNavigate } from "react-router";
import { useState, useCallback } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { programSignupUrl } from "../services/links.server";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";


export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const response = await admin.graphql(`
    query { currentAppInstallation { app { handle } } }
  `);
  const data = await response.json();
  const appHandle = process.env.SHOPIFY_APP_HANDLE || data.data.currentAppInstallation.app.handle;
  const shop = session.shop.replace(".myshopify.com", "");

  const dbPrograms = await prisma.program.findMany({
    where: { shopId: session.shop },
    include: {
      commissionConfig: true,
      creators: {
        include: { referrals: true }
      }
    },
    orderBy: { createdAt: 'desc' }
  });

  const programs = dbPrograms.map(p => ({
    id: p.id,
    name: p.name,
    type: p.commissionConfig?.type === 'PERCENTAGE' ? 'Percent of sale' : (p.commissionConfig?.type === 'FIXED_PER_ORDER' ? 'Fixed amount per order' : 'Fixed amount per item'),
    amount: p.commissionConfig?.type === 'PERCENTAGE' ? `${p.commissionConfig?.amount}%` : `$${p.commissionConfig?.amount}`,
    affiliates: p.creators.length,
    isDefault: p.isDefault,
    referrals: p.creators.reduce((sum, c) => sum + c.referrals.length, 0),
    active: p.status === 'ACTIVE',
    signupUrl: programSignupUrl(p.id),
  }));

  return { appHandle, shop, programs };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("actionType");
  const programId = formData.get("programId");

  if (actionType === "delete") {
    await prisma.program.delete({
      where: { id: programId, shopId: session.shop }
    });
  } else if (actionType === "toggle") {
    const program = await prisma.program.findUnique({ where: { id: programId } });
    if (program && program.shopId === session.shop) {
      await prisma.program.update({
        where: { id: programId },
        data: { status: program.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' }
      });
    }
  }

  return { success: true };
};

export default function Programs() {
  const { appHandle, shop, programs } = useLoaderData();
  const submit = useSubmit();
  const navigate = useNavigate();
  const [modalActive, setModalActive] = useState(false);
  const toggleModal = useCallback(() => setModalActive((active) => !active), []);

  const [deleteModalActive, setDeleteModalActive] = useState(false);
  const [programToDelete, setProgramToDelete] = useState(null);

  const [linkModalProgram, setLinkModalProgram] = useState(null);
  const [copiedId, setCopiedId] = useState(null);

  const copyLink = useCallback((id, link) => {
    navigator.clipboard.writeText(link);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const toggleProgramStatus = useCallback((id) => {
    submit({ actionType: "toggle", programId: id }, { method: "post" });
  }, [submit]);

  const confirmDelete = useCallback((id) => {
    setProgramToDelete(id);
    setDeleteModalActive(true);
  }, []);

  const handleDelete = useCallback(() => {
    if (programToDelete) {
      submit({ actionType: "delete", programId: programToDelete }, { method: "post" });
      setDeleteModalActive(false);
      setProgramToDelete(null);
    }
  }, [programToDelete, submit]);

  const handleUpgrade = () => {
    open(`https://admin.shopify.com/store/${shop}/charges/${appHandle}/pricing_plans`, '_top');
  };

  return (
    <Page fullWidth>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');

        :root{
          --blue-900:#1E3A8A;
          --blue-800:#1D4ED8;
          --blue-600:#2563EB;
          --blue-500:#3B82F6;
          --blue-tint:#EEF4FF;
          --blue-tint-2:#DBEAFE;
          --amber-600:#F59E0B;
          --amber-400:#FFB648;
          --amber-tint:#FFF6E5;
          --ink:#161A25;
          --muted:#6B7280;
          --muted-2:#8A93A3;
          --green-bg:#DEFBE8;
          --green-text:#0F8A4B;
          --red-text:#D0294B;
          --border:#E4E8F0;
          --border-soft:#EBEEF4;
        }
        .programs-page * { box-sizing:border-box; }
        .programs-page {
          font-family:'Inter',system-ui,-apple-system,sans-serif;
          background:#F0F2F6;
          color:var(--ink);
          margin: -1rem; /* Adjusting Polaris page margins */
        }
        .programs-page-inner { max-width:1280px; margin:0 auto; padding:26px 28px 60px; }

        .programs-page .page-header{ display:flex; align-items:center; justify-content:space-between; margin-bottom:20px; }
        .programs-page .page-header h1{ margin:0; font-size:23px; font-weight:800; letter-spacing:-.01em; }
        .programs-page .header-actions{ display:flex; gap:10px; }

        .programs-page .btn{ display:inline-flex; align-items:center; gap:7px; font-family:inherit; font-size:13.5px; font-weight:600; padding:10px 16px; border-radius:10px; cursor:pointer; border:1px solid var(--border); background:#fff; color:#374151; transition:all .15s ease; }
        .programs-page .btn:hover{ border-color:#C7CFDC; }
        .programs-page .btn.primary{ background:linear-gradient(135deg,var(--blue-600),var(--blue-900)); color:#fff; border:none; box-shadow:0 6px 14px -6px rgba(29,78,216,.5); }
        .programs-page .btn.primary:hover{ transform:translateY(-1px); }
        .programs-page .crown{ color:var(--amber-600); }

        /* ===================== promo banner ===================== */
        .programs-page .promo-card{
          display:grid;
          grid-template-columns:380px 1fr;
          background:#fff;
          border-radius:20px;
          overflow:hidden;
          box-shadow:0 18px 38px -22px rgba(29,78,216,.24), 0 2px 8px rgba(20,30,60,.05);
          margin-bottom:22px;
        }

        .programs-page .promo-illustration{
          position:relative;
          background:linear-gradient(150deg, var(--blue-500) 0%, var(--blue-900) 100%);
          overflow:hidden;
          padding:30px;
        }
        .programs-page .dot-grid{
          position:absolute; top:18px; right:18px;
          width:88px; height:88px;
          background-image:radial-gradient(rgba(255,255,255,.35) 1.4px, transparent 1.4px);
          background-size:11px 11px;
          opacity:.7;
        }
        .programs-page .mini-card{
          position:absolute;
          width:172px;
          background:#fff;
          border-radius:11px;
          box-shadow:0 14px 26px -10px rgba(10,20,50,.35);
          overflow:hidden;
        }
        .programs-page .mini-card .head{ background:var(--blue-900); color:#fff; font-size:11px; font-weight:700; padding:8px 12px; }
        .programs-page .mini-card .body{ padding:10px 12px; display:flex; flex-direction:column; gap:7px; }
        .programs-page .mini-card .line{ height:6px; border-radius:4px; background:#E7EAF1; }
        .programs-page .mini-card .line.short{ width:60%; }
        .programs-page .mini-card .pill-badge{ align-self:flex-start; font-size:10px; font-weight:700; padding:3px 8px; border-radius:100px; }

        .programs-page .mc1{ top:26px; left:18px; transform:rotate(-6deg); z-index:1; }
        .programs-page .mc2{ top:70px; left:120px; transform:rotate(4deg); z-index:2; }
        .programs-page .mc3{ top:150px; left:34px; transform:rotate(-3deg); z-index:3; }

        .programs-page .promo-content{ padding:30px 34px 28px; display:flex; flex-direction:column; gap:12px; }
        .programs-page .top-badge{
          display:inline-flex; align-items:center; gap:6px;
          width:fit-content;
          font-size:11px; font-weight:700; letter-spacing:.02em;
          color:#92620A;
          background:var(--amber-tint);
          border:1px solid #FBE3B0;
          padding:5px 12px;
          border-radius:100px;
        }
        .programs-page .promo-content h2{ margin:0; font-size:21px; font-weight:800; letter-spacing:-.01em; }
        .programs-page .promo-content p.desc{ margin:0; color:var(--muted); font-size:14px; line-height:1.55; max-width:56ch; }
        .programs-page .promo-list{ margin:2px 0 6px; padding:0; list-style:none; display:flex; flex-direction:column; gap:7px; }
        .programs-page .promo-list li{ display:flex; align-items:flex-start; gap:9px; font-size:13.5px; color:#374151; line-height:1.4; }
        .programs-page .promo-list li::before{ content:""; width:6px; height:6px; border-radius:50%; background:var(--blue-600); margin-top:6px; flex:none; }
        .programs-page .promo-list b{ color:var(--ink); font-weight:600; }

        .programs-page .unlock-btn{
          align-self:flex-start;
          display:inline-flex; align-items:center; gap:8px;
          border:none; cursor:pointer;
          padding:11px 20px; border-radius:10px;
          font-family:inherit; font-size:13.5px; font-weight:700; color:#5A3400;
          background:linear-gradient(135deg,#FFE1A0,var(--amber-400));
          box-shadow:0 8px 18px -8px rgba(245,158,11,.55);
          transition:transform .15s ease;
          margin-top:4px;
        }
        .programs-page .unlock-btn:hover{ transform:translateY(-1px); }

        /* ===================== program list card ===================== */
        .programs-page .list-card{ background:#fff; border:1px solid var(--border-soft); border-radius:16px; box-shadow:0 1px 2px rgba(20,30,60,.03); overflow:hidden; }
        .programs-page .list-header{ padding:20px 24px 4px; }
        .programs-page .list-header h3{ margin:0; font-size:15.5px; font-weight:700; }

        .programs-page .toolbar{ display:flex; align-items:center; justify-content:space-between; padding:16px 24px; gap:12px; }
        .programs-page .search-box{ display:flex; align-items:center; gap:8px; border:1px solid var(--border); border-radius:9px; padding:9px 13px; font-size:13px; color:var(--muted); width:260px; }
        .programs-page .toolbar-right{ display:flex; align-items:center; gap:10px; }
        .programs-page .toolbar-btn{ display:inline-flex; align-items:center; gap:6px; border:1px solid var(--border); background:#fff; color:#374151; font-family:inherit; font-size:13px; font-weight:600; padding:9px 13px; border-radius:9px; cursor:pointer; }
        .programs-page .toolbar-btn:hover{ border-color:#C7CFDC; }

        .programs-page table{ width:100%; border-collapse:collapse; }
        .programs-page thead th{ text-align:left; font-size:11px; font-weight:700; color:var(--muted-2); letter-spacing:.03em; text-transform:uppercase; padding:11px 24px; background:#FAFBFD; border-top:1px solid var(--border-soft); border-bottom:1px solid var(--border-soft); }
        .programs-page tbody td{ padding:16px 24px; font-size:13.5px; border-bottom:1px solid var(--border-soft); color:#374151; }
        .programs-page tbody tr:last-child td{ border-bottom:none; }
        .programs-page .name-cell-wrapper { display: flex; align-items: center; gap: 8px; }
        .programs-page .prog-name{ font-weight:700; color:var(--ink); }
        .programs-page .copy-icon { display: flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 4px; cursor: pointer; color: var(--blue-800); transition: all .15s ease; }
        .programs-page .copy-icon:hover { background: var(--blue-tint); }

        .programs-page .default-pill{ display:inline-flex; align-items:center; gap:5px; font-size:11.5px; font-weight:700; color:var(--blue-800); background:var(--blue-tint); padding:4px 10px; border-radius:100px; }
        .programs-page .default-pill svg{ flex:none; }

        .programs-page .actions-cell{ display:flex; align-items:center; gap:14px; }
        .programs-page .toggle{ width:34px; height:19px; border-radius:100px; background:var(--blue-600); position:relative; flex:none; cursor: pointer; transition: background-color 0.2s ease; }
        .programs-page .toggle::after{ content:""; position:absolute; top:2px; right:2px; width:15px; height:15px; border-radius:50%; background:#fff; transition: right 0.2s ease, left 0.2s ease; }
        .programs-page .toggle.off { background: var(--muted-2); }
        .programs-page .toggle.off::after { right: auto; left: 2px; }
        .programs-page .icon-btn{ width:28px; height:28px; display:flex; align-items:center; justify-content:center; border-radius:7px; color:var(--muted); cursor:pointer; }
        .programs-page .icon-btn:hover{ background:#F3F5F9; color:#374151; }
        .programs-page .icon-btn.danger:hover{ background:#FDEDEF; color:var(--red-text); }

        .programs-page .table-footer{ display:flex; align-items:center; justify-content:space-between; padding:16px 24px; }
        .programs-page .entries-select{ display:flex; align-items:center; gap:6px; border:1px solid var(--border); border-radius:8px; padding:7px 11px; font-size:12.5px; font-weight:600; color:#374151; }
        .programs-page .total-entries{ font-size:12.5px; color:var(--muted); margin-left:12px; }
        .programs-page .footer-left{ display:flex; align-items:center; }
        .programs-page .pagination{ display:flex; align-items:center; gap:6px; }
        .programs-page .page-btn{ width:28px; height:28px; display:flex; align-items:center; justify-content:center; border-radius:7px; border:1px solid var(--border); color:#6B7280; cursor:pointer; background:#fff; }
        .programs-page .page-btn.current{ border-color:var(--blue-600); color:var(--blue-600); font-weight:700; font-size:12.5px; }
      `}</style>
      <div className="programs-page">
        <div className="programs-page-inner">

          <div className="page-header">
            <h1>Programs</h1>
            <div className="header-actions">
              <button className="btn primary" onClick={() => navigate('/app/programs/new')}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M12 5v14M5 12h14"/></svg>
                Add program
              </button>
            </div>
          </div>

          {/* promo banner */}
          <div className="promo-card">
            <div className="promo-illustration">
              <div className="dot-grid"></div>

              <div className="mini-card mc1">
                <div className="head">Program 1</div>
                <div className="body">
                  <div className="line"></div>
                  <div className="line short"></div>
                  <span className="pill-badge" style={{background: 'var(--green-bg)', color: 'var(--green-text)'}}>10% commission</span>
                </div>
              </div>

              <div className="mini-card mc2">
                <div className="head">Program 2</div>
                <div className="body">
                  <div className="line"></div>
                  <div className="line short"></div>
                  <span className="pill-badge" style={{background: 'var(--blue-tint)', color: 'var(--blue-800)'}}>15% commission</span>
                </div>
              </div>

              <div className="mini-card mc3">
                <div className="head">Program 3</div>
                <div className="body">
                  <div className="line"></div>
                  <div className="line short"></div>
                  <span className="pill-badge" style={{background: 'var(--amber-tint)', color: '#92620A'}}>$5 commission</span>
                </div>
              </div>
            </div>

            <div className="promo-content">
              <span className="top-badge">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.9 6.6L22 9.3l-5 4.9 1.2 7.1L12 17.8l-6.2 3.5L7 14.2 2 9.3l7.1-.7z"/></svg>
                TOP USED FEATURE
              </span>
              <h2>Multiple programs</h2>
              <p className="desc">Create various programs with different commission rules.</p>
              <ul className="promo-list">
                <li><b>Tailor</b> affiliate programs for different strategies</li>
                <li><b>Classify</b> affiliates into groups based on specific strategies or goals</li>
              </ul>
              <button className="unlock-btn" onClick={toggleModal}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M2 18h20l-1.5-9-5 4-3.5-7-3.5 7-5-4L2 18z"/></svg>
                Unlock now
              </button>
            </div>
          </div>

          {/* program list */}
          <div className="list-card">
            <div className="list-header"><h3>Program list</h3></div>

            <div className="toolbar">
              <div className="search-box">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
                Search
              </div>
              <div className="toolbar-right">
                <button className="toolbar-btn">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/></svg>
                  Custom columns
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M7 10l5 5 5-5"/></svg>
                </button>
                <button className="toolbar-btn">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 19h16"/></svg>
                  Export file
                </button>
              </div>
            </div>

            <table>
              <thead>
                <tr>
                  <th>Name</th><th>Type</th><th>Amount</th><th>Affiliates ↕</th><th>Default program</th><th>Referrals ↕</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {programs.length === 0 ? (
                  <tr>
                    <td colSpan="7" style={{ textAlign: 'center', padding: '40px' }}>
                      <div style={{ color: 'var(--muted)' }}>No programs found. Click <strong>Add program</strong> to create one.</div>
                    </td>
                  </tr>
                ) : programs.map((prog) => (
                  <tr key={prog.id}>
                    <td>
                      <div className="name-cell-wrapper">
                        <div className="prog-name">{prog.name}</div>
                        <Tooltip content="Get registration link">
                          <span className="copy-icon" onClick={() => setLinkModalProgram(prog)}>
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                            </svg>
                          </span>
                        </Tooltip>
                      </div>
                    </td>
                    <td>{prog.type}</td>
                    <td>{prog.amount}</td>
                    <td>{prog.affiliates}</td>
                    <td>
                      {prog.isDefault ? (
                        <span className="default-pill">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>
                          Default
                        </span>
                      ) : null}
                    </td>
                    <td>{prog.referrals}</td>
                    <td>
                      <div className="actions-cell">
                        <Tooltip content={prog.active ? "Deactivate program" : "Activate program"}>
                          <div className={`toggle ${prog.active ? '' : 'off'}`} onClick={() => toggleProgramStatus(prog.id)}></div>
                        </Tooltip>
                        <Tooltip content="Edit program">
                          <span className="icon-btn" onClick={() => navigate(`/app/programs/${prog.id}`)}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></span>
                        </Tooltip>
                        <Tooltip content="Delete program">
                          <span className="icon-btn danger" onClick={() => confirmDelete(prog.id)}><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg></span>
                        </Tooltip>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="table-footer">
              <div className="footer-left">
                <div className="entries-select">10 entries
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M7 10l5 5 5-5"/></svg>
                </div>
                <span className="total-entries">Total {programs.length} entries</span>
              </div>
              <div className="pagination">
                <div className="page-btn"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M15 6l-6 6 6 6"/></svg></div>
                <div className="page-btn current">1</div>
                <div className="page-btn"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4"><path d="M9 6l6 6-6 6"/></svg></div>
              </div>
            </div>
          </div>

        </div>
      </div>

      <Modal
        open={modalActive}
        onClose={toggleModal}
        title="Unlock more features?"
        size="large"
      >
        <Modal.Section>
          <div style={{ display: 'flex', gap: '32px', alignItems: 'stretch', justifyContent: 'center' }}>
            {/* Free Plan */}
            <div style={{ flex: '0 1 360px', border: '1px solid #dfe3e8', borderRadius: '8px', padding: '24px', display: 'flex', flexDirection: 'column' }}>
              <div style={{ fontSize: '15px', color: '#202223', marginBottom: '8px' }}>Free to Install</div>
              <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#202223', marginBottom: '16px' }}>Free</div>
              <div style={{ fontSize: '12px', color: '#6d7175', marginBottom: '24px', opacity: 0 }}>placeholder</div>
              
              <Form method="post" style={{ marginBottom: '24px' }}>
                <input type="hidden" name="plan" value="Free" />
                <button type="button" style={{ width: '100%', padding: '10px', background: '#f4f6f8', border: '1px solid #c4cdd5', borderRadius: '4px', color: '#8c9196', fontWeight: 'bold', cursor: 'not-allowed' }}>Current plan</button>
              </Form>

              <div style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '16px' }}>Available features:</div>
              <div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '14px', color: '#6d7175' }}>
                  <li style={{ marginBottom: '12px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}><span style={{ color: '#8c9196' }}>✓</span> Affiliate link & coupon tracking</li>
                  <li style={{ marginBottom: '12px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}><span style={{ color: '#8c9196' }}>✓</span> Creator signup & registration page</li>
                  <li style={{ marginBottom: '12px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}><span style={{ color: '#8c9196' }}>✓</span> Unlimited creator applications</li>
                  <li style={{ marginBottom: '12px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}><span style={{ color: '#8c9196' }}>✓</span> Order & commission tracking</li>
                  <li style={{ marginBottom: '12px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}><span style={{ color: '#8c9196' }}>✓</span> Special product commission</li>
                </ul>
              </div>
            </div>

            {/* Growth Plan */}
            <div style={{ flex: '0 1 360px', border: '3px solid #84c9fa', borderRadius: '8px', padding: '24px', display: 'flex', flexDirection: 'column', position: 'relative' }}>
              <div style={{ position: 'absolute', top: 0, left: 0, right: 0, background: '#84c9fa', color: '#002b4d', fontSize: '11px', fontWeight: '700', textAlign: 'center', padding: '6px 0', borderTopLeftRadius: '4px', borderTopRightRadius: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>RECOMMENDED</div>
              
              <div style={{ marginTop: '24px', fontSize: '15px', color: '#202223', marginBottom: '8px' }}>Growth</div>
              <div style={{ fontSize: '32px', fontWeight: 'bold', color: '#002b4d', marginBottom: '4px' }}>$15.99</div>
              
              <div style={{ fontSize: '12px', color: '#6d7175', marginBottom: '24px', textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: '4px' }}>+ 2% successful referral sales</div>
              
              <div style={{ marginBottom: '16px' }}>
                <button type="button" onClick={handleUpgrade} style={{ width: '100%', padding: '12px', background: '#303030', border: 'none', borderRadius: '4px', color: '#ffffff', fontWeight: 'bold', cursor: 'pointer', fontSize: '15px' }}>Choose plan</button>
              </div>

              <div style={{ background: '#f1f8f5', color: '#002b4d', padding: '10px', borderRadius: '4px', textAlign: 'center', fontSize: '13px', fontWeight: '500', marginBottom: '24px', border: '1px solid #dcf1e7' }}>
                🎉 You'll get 7-day free trial!
              </div>

              <div style={{ fontWeight: 'bold', fontSize: '13px', marginBottom: '16px', color: '#202223' }}>All Free features, and:</div>
              <div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: '14px', color: '#6d7175' }}>
                  <li style={{ marginBottom: '12px', display: 'flex', gap: '10px', alignItems: 'flex-start', color: '#2c6ecb', fontWeight: 'bold' }}><span>✨</span> Multiple programs</li>
                  <li style={{ marginBottom: '12px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}><span style={{ color: '#8c9196' }}>✓</span> Unlimited commission rules</li>
                  <li style={{ marginBottom: '12px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}><span style={{ color: '#8c9196' }}>✓</span> Bulk creator management</li>
                  <li style={{ marginBottom: '12px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}><span style={{ color: '#8c9196' }}>✓</span> Custom branding</li>
                  <li style={{ marginBottom: '12px', display: 'flex', gap: '10px', alignItems: 'flex-start' }}><span style={{ color: '#8c9196' }}>✓</span> Advanced creator performance insights</li>
                </ul>
              </div>
            </div>
          </div>
          
          <div style={{ marginTop: '32px', textAlign: 'center', color: '#6d7175', fontSize: '13.5px' }}>
            💡 <strong>Tip:</strong> Upgrading to the Growth plan allows you to create highly targeted commission structures for different creator tiers!
          </div>
        </Modal.Section>
      </Modal>

      <Modal
        open={deleteModalActive}
        onClose={() => setDeleteModalActive(false)}
        title="Delete program"
        primaryAction={{
          content: 'Delete',
          destructive: true,
          onAction: handleDelete,
        }}
        secondaryActions={[
          {
            content: 'Cancel',
            onAction: () => setDeleteModalActive(false),
          },
        ]}
      >
        <Modal.Section>
          <p>Are you sure you want to delete this program? This action cannot be undone.</p>
        </Modal.Section>
      </Modal>
      <Modal
        open={!!linkModalProgram}
        onClose={() => { setLinkModalProgram(null); setCopiedId(null); }}
        title="Get registration link"
      >
        <Modal.Section>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ background: '#f1f8f5', color: '#002b4d', padding: '12px 16px', borderRadius: '8px', fontSize: '13.5px', border: '1px solid #dcf1e7', lineHeight: '1.5' }}>
              💡 Share this unique link with creators. Anyone who signs up using this link will automatically join the <strong>{linkModalProgram?.name}</strong> program.
            </div>
            
            <div style={{ display: 'flex', gap: '8px', alignItems: 'stretch' }}>
              <div style={{ flex: 1, padding: '10px 14px', background: '#F4F6F8', border: '1px solid #C4CDD5', borderRadius: '8px', fontSize: '14px', color: '#202223', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'flex', alignItems: 'center' }}>
                {linkModalProgram?.signupUrl}
              </div>
              <button
                onClick={() => copyLink('modal', linkModalProgram?.signupUrl)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  backgroundColor: copiedId === 'modal' ? '#008060' : '#1d4ed8', 
                  color: 'white', 
                  border: 'none', 
                  borderRadius: 'var(--p-border-radius-150)', 
                  padding: '8px 16px', 
                  cursor: 'pointer', 
                  fontWeight: '600', 
                  fontSize: '13px',
                  boxShadow: 'inset 0 1px 0 0 rgba(255,255,255,0.1)',
                  transition: 'background-color 0.2s ease, width 0.2s ease',
                  margin: 0
                }}
              >
                <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M6 4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2h-2v2H6V6h2V4H6zm4-4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2h-8zm0 2h8v10h-8V2z"/></svg>
                {copiedId === 'modal' ? 'Copied!' : 'Copy link'}
              </button>
            </div>
          </div>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
