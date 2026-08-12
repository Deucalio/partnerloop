import { redirect, useLoaderData, useNavigate, useSearchParams } from "react-router";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Button,
  InlineGrid,
  Select,
  IndexTable,
  Badge,
  Box,
  Divider,
  Avatar,
  Banner,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { getDashboardData, syncStoreCurrency } from "../services/dashboard.server";
import { getEmbedStatus } from "../services/embed-status.server";
import { getAttentionItems, syncEmbedStatus } from "../services/attention.server";
import { AttentionCard } from "../components/AttentionCard";
import { PERIODS } from "../periods";
import { programSignupUrl } from "../services/links.server";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useCallback } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const period = url.searchParams.get("period") || "30d";
  const programId = url.searchParams.get("program") || "all";

  const dashboardData = await getDashboardData({ shop: session.shop, period, programId });

  // getDashboardData returns null when the store has not finished onboarding.
  if (!dashboardData) {
    return redirect(`/app/onboarding${url.search}`);
  }

  const response = await admin.graphql(
    `#graphql
    query {
      shop {
        currencyCode
      }
    }`
  );
  const data = await response.json();
  const currency = data.data?.shop?.currencyCode || 'USD';

  await syncStoreCurrency(session.shop, currency);

  // Clicks and order attribution both depend on the storefront app embed, which
  // merchants have to switch on themselves.
  const embedStatus = await getEmbedStatus(admin);
  await syncEmbedStatus(session.shop, embedStatus.state);
  const attention = await getAttentionItems(session.shop);
  const storeHandle = session.shop.split(".")[0];

  return {
    attention,
    embedStatus,
    themeEditorUrl: embedStatus.themeId
      ? `https://admin.shopify.com/store/${storeHandle}/themes/${embedStatus.themeId}/editor?context=apps`
      : `https://admin.shopify.com/store/${storeHandle}/themes`,
    storeName: session.shop.split(".")[0],
    dashboardData,
    hasData: dashboardData.hasData,
    currency,
    period,
    programId,
    signupUrl: dashboardData.defaultProgram
      ? programSignupUrl(dashboardData.defaultProgram.id)
      : null,
  };
};

export default function Dashboard() {
  const {
    storeName,
    dashboardData,
    hasData,
    currency,
    period,
    programId,
    signupUrl,
    embedStatus,
    themeEditorUrl,
    attention,
  } = useLoaderData();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [chartMetric, setChartMetric] = useState("revenue");
  const [isCopied, setIsCopied] = useState(false);

  // Filters live in the URL so the loader can re-run against the new range.
  // Merging into the existing params keeps Shopify's embedded-app query string
  // (host, embedded, id_token) intact across the navigation.
  const updateFilter = useCallback(
    (key, value) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set(key, value);
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  const handleCopyLink = () => {
    if (!signupUrl) return;
    navigator.clipboard.writeText(signupUrl);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency }).format(amount);
  };

  const formatNumber = (num) => {
    return new Intl.NumberFormat('en-US').format(num);
  };

  const isMoneyMetric = chartMetric === 'revenue' || chartMetric === 'commissions';

  const chartTotal = dashboardData.chart.reduce((sum, point) => sum + point[chartMetric], 0);

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      const formattedValue = isMoneyMetric
        ? formatCurrency(payload[0].value)
        : formatNumber(payload[0].value);
      return (
        <div style={{
          backgroundColor: '#202223',
          color: 'white',
          padding: '8px 12px',
          borderRadius: '8px',
          fontSize: '13px',
          fontWeight: '600',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          zIndex: 10
        }}>
          <div style={{color: '#a6a8ab', fontSize: '11px', marginBottom: '2px', fontWeight: 'normal'}}>{label}</div>
          <div style={{color: '#e5d5f2'}}>{formattedValue} {chartMetric === 'revenue' ? '' : chartMetric}</div>
        </div>
      );
    }
    return null;
  };

  const programOptions = [
    { label: 'All programs', value: 'all' },
    ...dashboardData.programs.map((program) => ({ label: program.name, value: program.id })),
  ];

  return (
    <Page fullWidth>
      <TitleBar title="Dashboard" />
      <BlockStack gap="600">

        {/* Header Section */}
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text variant="headingXl" as="h1">Welcome back, {storeName}</Text>
            <Text tone="subdued">Here's your creator program overview.</Text>
          </BlockStack>
          <InlineStack gap="300">
            <Button onClick={() => navigate('/app/programs')}>View programs</Button>
            <Button
              variant="primary"
              disabled={!signupUrl}
              onClick={() => open(signupUrl, '_blank')}
              accessibilityLabel="Open the creator signup page"
            >
              Invite creator
            </Button>
          </InlineStack>
        </InlineStack>

        {/* Filters */}
        <InlineStack gap="300">
          <Select
            label="Program"
            labelInline
            options={programOptions}
            value={programId}
            onChange={(value) => updateFilter('program', value)}
          />
          <Select
            label="Period"
            labelInline
            options={PERIODS}
            value={period}
            onChange={(value) => updateFilter('period', value)}
          />
        </InlineStack>

        {/* Tracking not switched on. App embeds are off by default, so without
            this the merchant's numbers stay at zero with no explanation. */}
        {embedStatus.state === 'inactive' && (
          <Banner
            tone="warning"
            title="Referral tracking isn't switched on yet"
            action={{
              content: 'Turn on in theme editor',
              onAction: () => open(themeEditorUrl, '_top'),
            }}
          >
            <BlockStack gap="200">
              <Text>
                Creator links won't record clicks, and referred orders won't be credited to
                anyone, until you enable the <b>PartnerLoop tracking</b> app embed in your live
                theme{embedStatus.themeName ? ` (${embedStatus.themeName})` : ''}.
              </Text>
              <Text tone="subdued" variant="bodySm">
                In the theme editor, open <b>App embeds</b> in the left sidebar, switch on
                PartnerLoop tracking, and save. Nothing else needs changing.
              </Text>
            </BlockStack>
          </Banner>
        )}

        {/* Creator Signup Link */}
        <div style={{
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
          borderRadius: 'var(--p-border-radius-300)',
          backgroundColor: 'var(--p-color-bg-surface)',
          borderLeft: '4px solid #1d4ed8',
          overflow: 'hidden'
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', background: 'var(--p-color-bg-surface)' }}>
            <div style={{ flex: '1 1 50%', padding: 'var(--p-space-500)', minWidth: '350px' }}>
              <BlockStack gap="400">
                <InlineStack gap="300" blockAlign="center">
                  <div style={{ fontSize: '24px', fontWeight: '700', color: '#202223' }}>Creator signup link</div>
                  {dashboardData.programHealth.status === 'Active' ? (
                    <Badge tone="success"><span style={{fontWeight: 'bold'}}>● Active</span></Badge>
                  ) : (
                    <Badge><span style={{fontWeight: 'bold'}}>● Inactive</span></Badge>
                  )}
                </InlineStack>

                <div style={{ fontSize: '15px', color: '#6d7175', marginBottom: '8px' }}>
                  Invite creators to join your program. Anyone who signs up through this link is tracked automatically.
                </div>

                <BlockStack gap="200">
                  <div style={{ fontSize: '11px', fontWeight: '700', color: '#6d7175', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                    Your creator signup URL
                  </div>
                  <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  background: '#ffffff',
                  padding: '6px',
                  borderRadius: 'var(--p-border-radius-200)',
                  border: '1px solid #bfdbfe',
                  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.02)'
                }}>
                  <div style={{ paddingLeft: '8px', minWidth: 0 }}>
                    <div style={{ fontFamily: 'Consolas, Monaco, "Courier New", monospace', fontSize: '14px', color: '#202223', letterSpacing: '0.2px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {signupUrl ?? 'Create a program to get your signup link'}
                    </div>
                  </div>
                  <button onClick={handleCopyLink} disabled={!signupUrl} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    backgroundColor: isCopied ? '#008060' : '#1d4ed8',
                    color: 'white',
                    border: 'none',
                    borderRadius: 'var(--p-border-radius-150)',
                    padding: '8px 16px',
                    cursor: signupUrl ? 'pointer' : 'not-allowed',
                    opacity: signupUrl ? 1 : 0.5,
                    fontWeight: '600',
                    fontSize: '13px',
                    flexShrink: 0,
                    boxShadow: 'inset 0 1px 0 0 rgba(255,255,255,0.1)',
                    transition: 'background-color 0.2s ease, width 0.2s ease'
                  }}>
                    <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M6 4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2h-2v2H6V6h2V4H6zm4-4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2h-8zm0 2h8v10h-8V2z"/></svg>
                    {isCopied ? 'Copied!' : 'Copy link'}
                  </button>
                </div>
                </BlockStack>
                {(() => {
                  const creatorCount = dashboardData.programHealth.totalCreators;

                  let boxTheme = { bg: '#eff6ff', iconBg: '#bfdbfe', iconColor: '#1d4ed8', title: 'Ready to grow?', desc: 'Share your signup link with creators to start building your network.' };

                  if (creatorCount > 25) {
                    boxTheme = { bg: '#eff6ff', iconBg: '#61d384', iconColor: '#ffffff', title: 'Your creator network is growing!', desc: `You now have ${creatorCount} creators registered in your program.` };
                  } else if (creatorCount > 0) {
                    boxTheme = { bg: '#eff6ff', iconBg: '#ffc453', iconColor: '#b35f00', title: 'Grow your creator network', desc: `You have ${creatorCount} creators in your program. Keep sharing your signup link to grow your network.` };
                  }

                  return (
                    <div style={{ display: 'flex', border: '1px solid #dbeafe', borderRadius: '8px', overflow: 'hidden', background: boxTheme.bg, marginTop: '8px' }}>
                      <div style={{ flex: '0 0 35%', padding: '20px', borderRight: '1px solid #dbeafe', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                        <div style={{ fontSize: '36px', fontWeight: '800', color: '#1d4ed8', lineHeight: '1' }}>{creatorCount}</div>
                        <div style={{ fontSize: '11px', fontWeight: '700', color: '#6d7175', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Creators Registered</div>
                        {creatorCount > 0 && (
                          <div style={{ marginTop: '12px' }}>
                            <Button variant="plain" onClick={() => navigate('/app/creators')}>
                              View creators →
                            </Button>
                          </div>
                        )}
                      </div>
                      <div style={{ flex: '1', padding: '20px', display: 'flex', gap: '16px', alignItems: 'center' }}>
                        <div style={{
                          width: '40px', height: '40px', borderRadius: '12px', background: boxTheme.iconBg, color: boxTheme.iconColor,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                        }}>
                          {creatorCount > 25 ? (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
                              <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"></polyline>
                              <polyline points="17 6 23 6 23 12"></polyline>
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20">
                              <path d="M9 18h6"></path>
                              <path d="M10 22h4"></path>
                              <path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1.3.47 2.2 1.5 3.5.76.76 1.23 1.52 1.41 2.5"></path>
                            </svg>
                          )}
                        </div>
                        <div>
                          <div style={{ fontSize: '15px', fontWeight: '700', color: '#202223', marginBottom: '4px' }}>{boxTheme.title}</div>
                          <div style={{ fontSize: '14px', color: '#6d7175', lineHeight: '1.4' }}>{boxTheme.desc}</div>
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </BlockStack>
            </div>
            <div style={{ flex: '1 1 50%', position: 'relative', minHeight: '200px' }}>
               <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundImage: 'url(/new-two.jpeg)', backgroundSize: 'cover', backgroundPosition: 'left center' }}></div>
            </div>
          </div>
        </div>

        {/* KPI Cards */}
        <InlineGrid columns={{xs: 1, sm: 2, md: 4}} gap="400">
          <MetricCard
            title="Attributed revenue"
            value={formatCurrency(dashboardData.metrics.totalRevenue)}
            change={dashboardData.metrics.totalRevenueChange}
            hasData={hasData}
            footnote={
              dashboardData.metrics.commissionableRevenue !== dashboardData.metrics.totalRevenue
                ? `${formatCurrency(dashboardData.metrics.commissionableRevenue)} commissionable`
                : null
            }
          />
          <MetricCard
            title="Orders"
            value={formatNumber(dashboardData.metrics.orders)}
            change={dashboardData.metrics.ordersChange}
            hasData={hasData}
          />
          <MetricCard
            title="Clicks"
            value={dashboardData.metrics.clicks === null ? '—' : formatNumber(dashboardData.metrics.clicks)}
            change={dashboardData.metrics.clicksChange}
            hasData={hasData}
            untracked={dashboardData.metrics.clicks === null}
          />
          <MetricCard
            title="Conversion rate"
            value={dashboardData.metrics.conversionRate === null ? '—' : `${dashboardData.metrics.conversionRate}%`}
            change={dashboardData.metrics.conversionRateChange}
            hasData={hasData}
            untracked={dashboardData.metrics.conversionRate === null}
          />
        </InlineGrid>

        {/* Revenue Performance & Program Health */}
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text variant="headingMd" as="h2">Performance</Text>
                  <Select
                    label="Metric"
                    labelHidden
                    options={[
                      {label: 'Revenue', value: 'revenue'},
                      {label: 'Orders', value: 'orders'},
                      {label: 'Commissions', value: 'commissions'}
                    ]}
                    value={chartMetric}
                    onChange={setChartMetric}
                  />
                </InlineStack>

                {hasData ? (
                  <BlockStack gap="400">
                    <BlockStack gap="100">
                      <Text variant="headingXl" as="p">
                        {isMoneyMetric ? formatCurrency(chartTotal) : formatNumber(chartTotal)}
                      </Text>
                      <InlineStack gap="200" blockAlign="center">
                        <ChangeLabel
                          change={chartMetric === 'orders'
                            ? dashboardData.metrics.ordersChange
                            : dashboardData.metrics.totalRevenueChange}
                        />
                      </InlineStack>
                    </BlockStack>

                    <Box minHeight="200px" background="bg-surface" borderRadius="200" padding="400" borderWidth="025" borderColor="border">
                      <div style={{ width: '100%', height: 250 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={dashboardData.chart} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
                            <defs>
                              <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#1d4ed8" stopOpacity={0.3}/>
                                <stop offset="95%" stopColor="#1d4ed8" stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <YAxis
                              axisLine={false}
                              tickLine={false}
                              tick={{fill: 'var(--p-color-text-subdued)', fontSize: 12}}
                              tickFormatter={(value) => isMoneyMetric ? formatCurrency(value) : formatNumber(value)}
                              width={80}
                            />
                            <XAxis
                              dataKey="date"
                              axisLine={false}
                              tickLine={false}
                              tick={{fill: 'var(--p-color-text-subdued)', fontSize: 12}}
                              dy={10}
                            />
                            <RechartsTooltip content={<CustomTooltip />} />
                            <Area
                              type="monotone"
                              dataKey={chartMetric}
                              stroke="#1d4ed8"
                              strokeWidth={3}
                              fillOpacity={1}
                              fill="url(#colorValue)"
                              activeDot={{ r: 6, fill: '#1d4ed8', stroke: '#fff', strokeWidth: 2 }}
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </Box>
                  </BlockStack>
                ) : (
                  <Box minHeight="300px" padding="400" background="bg-surface-secondary" borderRadius="200" borderWidth="025" borderColor="border">
                    <InlineStack align="center" blockAlign="center">
                      <BlockStack gap="200" align="center" inlineAlign="center">
                        <Text variant="headingSm" as="h3">No referral sales yet</Text>
                        <Text tone="subdued">Your performance data will appear here once creators start generating sales.</Text>
                      </BlockStack>
                    </InlineStack>
                  </Box>
                )}
              </BlockStack>
            </Card>

            <Box paddingBlockStart="400">
              {/* Top Creators */}
              <Card padding="0">
                <Box padding="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <Text variant="headingMd" as="h2">Top creators</Text>
                    <Button variant="plain" onClick={() => navigate('/app/creators')}>View all creators →</Button>
                  </InlineStack>
                </Box>

                {dashboardData.topCreators.length > 0 ? (
                  <IndexTable
                    itemCount={dashboardData.topCreators.length}
                    headings={[
                      { title: 'Creator' },
                      { title: 'Sales', alignment: 'end' },
                      { title: 'Orders', alignment: 'end' },
                      { title: 'Commission', alignment: 'end' },
                    ]}
                    selectable={false}
                  >
                    {dashboardData.topCreators.map(
                      (creator, index) => (
                        <IndexTable.Row id={creator.id} key={creator.id} position={index}>
                          <IndexTable.Cell>
                            <InlineStack gap="300" blockAlign="center" wrap={false}>
                              <Avatar size="sm" customer name={creator.name} />
                              <Text fontWeight="bold" as="span">{creator.name}</Text>
                            </InlineStack>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            <Text as="span" alignment="end">{formatCurrency(creator.sales)}</Text>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            <Text as="span" alignment="end">{creator.orders}</Text>
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            <Badge tone="success">{formatCurrency(creator.commission)}</Badge>
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      ),
                    )}
                  </IndexTable>
                ) : (
                  <Box padding="800">
                    <BlockStack gap="400" align="center" inlineAlign="center">
                      <Text variant="headingSm" as="h3" alignment="center">No creators yet</Text>
                      <Text tone="subdued" alignment="center">Invite creators to start building your partner network.</Text>
                      <Button disabled={!signupUrl} onClick={() => open(signupUrl, '_blank')}>Invite creator</Button>
                    </BlockStack>
                  </Box>
                )}
              </Card>
            </Box>
          </Layout.Section>

          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              <AttentionCard items={attention.items} />

              {/* Program Health */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Program health</Text>

                  <InlineStack align="space-between">
                    <Text>Program status</Text>
                    <Badge tone={dashboardData.programHealth.status === 'Active' ? 'success' : undefined}>
                      {dashboardData.programHealth.status}
                    </Badge>
                  </InlineStack>
                  <Divider />

                  <InlineStack align="space-between">
                    <Text>Total creators</Text>
                    <Badge tone="info">{String(dashboardData.programHealth.totalCreators)}</Badge>
                  </InlineStack>
                  <Divider />

                  <InlineStack align="space-between">
                    <Text>Active creators</Text>
                    <Badge tone="success">{String(dashboardData.programHealth.activeCreators)}</Badge>
                  </InlineStack>
                  <Divider />

                  <InlineStack align="space-between">
                    <Text>Pending approval</Text>
                    <Badge tone={dashboardData.programHealth.pendingApproval > 0 ? 'warning' : undefined}>
                      {String(dashboardData.programHealth.pendingApproval)}
                    </Badge>
                  </InlineStack>
                  <Divider />

                  <InlineStack align="space-between">
                    <Text>Link tracking</Text>
                    <Badge tone={dashboardData.programHealth.linkTracking ? 'success' : undefined}>
                      {dashboardData.programHealth.linkTracking ? 'Active' : 'Off'}
                    </Badge>
                  </InlineStack>
                  <Divider />

                  <InlineStack align="space-between">
                    <Text>Coupon tracking</Text>
                    <Badge tone={dashboardData.programHealth.couponTracking ? 'success' : undefined}>
                      {dashboardData.programHealth.couponTracking ? 'Active' : 'Off'}
                    </Badge>
                  </InlineStack>
                </BlockStack>
              </Card>

              {/* Commission Overview */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Commission overview</Text>

                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="200" blockAlign="center">
                      <Box background="bg-surface-warning" borderRadius="100" padding="100">
                        <Box padding="100" />
                      </Box>
                      <Text tone="subdued">Pending</Text>
                    </InlineStack>
                    <Text fontWeight="semibold">{formatCurrency(dashboardData.commissions.pending)}</Text>
                  </InlineStack>

                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="200" blockAlign="center">
                      <Box background="bg-surface-info" borderRadius="100" padding="100">
                        <Box padding="100" />
                      </Box>
                      <Text tone="subdued">Approved</Text>
                    </InlineStack>
                    <Text fontWeight="semibold">{formatCurrency(dashboardData.commissions.approved)}</Text>
                  </InlineStack>

                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="200" blockAlign="center">
                      <Box background="bg-surface-success" borderRadius="100" padding="100">
                        <Box padding="100" />
                      </Box>
                      <Text tone="subdued">Paid</Text>
                    </InlineStack>
                    <Text fontWeight="semibold">{formatCurrency(dashboardData.commissions.paid)}</Text>
                  </InlineStack>

                  {dashboardData.commissions.rejected > 0 && (
                    <InlineStack align="space-between" blockAlign="center">
                      <InlineStack gap="200" blockAlign="center">
                        <Box background="bg-surface-critical" borderRadius="100" padding="100">
                          <Box padding="100" />
                        </Box>
                        <Text tone="subdued">Rejected</Text>
                      </InlineStack>
                      <Text fontWeight="semibold" tone="subdued">{formatCurrency(dashboardData.commissions.rejected)}</Text>
                    </InlineStack>
                  )}
                </BlockStack>
              </Card>

              {/* Recent Activity */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Recent activity</Text>

                  {dashboardData.recentActivity.length > 0 ? (
                    <BlockStack gap="400">
                      {dashboardData.recentActivity.map((activity, idx) => (
                        <InlineStack key={activity.id} gap="300" blockAlign="start" wrap={false}>
                          <Box paddingBlockStart="100">
                            <Box background={idx === 0 ? "bg-surface-success" : idx === 1 ? "bg-surface-info" : "bg-surface-warning"} borderRadius="100" padding="150" />
                          </Box>
                          <BlockStack gap="100">
                            <Text>{activity.text}</Text>
                            <Text tone="subdued" variant="bodySm">{activity.time}</Text>
                          </BlockStack>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  ) : (
                    <Box paddingBlock="400">
                      <BlockStack gap="200" align="center" inlineAlign="center">
                        <Text tone="subdued" alignment="center">No activity yet</Text>
                        <Text tone="subdued" variant="bodySm" alignment="center">
                          Creator activity will appear here once your program gets started.
                        </Text>
                      </BlockStack>
                    </Box>
                  )}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>

      </BlockStack>
    </Page>
  );
}

function ChangeLabel({ change }) {
  if (change === null) {
    return <Text tone="subdued" variant="bodySm">No comparison data</Text>;
  }

  const isPositive = change > 0;
  const isNegative = change < 0;

  return (
    <>
      <Text tone={isPositive ? "success" : isNegative ? "critical" : "subdued"}>
        {isPositive ? '↑' : isNegative ? '↓' : ''} {Math.abs(change)}%
      </Text>
      <Text tone="subdued">vs previous period</Text>
    </>
  );
}

function MetricCard({ title, value, change, hasData, untracked = false, footnote = null }) {
  return (
    <Card>
      <BlockStack gap="200">
        <Text tone="subdued">{title}</Text>
        <Text variant="headingLg" as="p">{value}</Text>
        {footnote ? <Text tone="subdued" variant="bodySm">{footnote}</Text> : null}

        {untracked ? (
          <Text tone="subdued" variant="bodySm">Not tracked yet</Text>
        ) : hasData ? (
          <InlineStack gap="100" blockAlign="center">
            <ChangeLabel change={change} />
          </InlineStack>
        ) : (
          <Text tone="subdued" variant="bodySm">No referral sales yet</Text>
        )}
      </BlockStack>
    </Card>
  );
}
