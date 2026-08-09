import { redirect, useLoaderData, useNavigate } from "react-router";
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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useCallback } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer } from 'recharts';

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  
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

  const store = await prisma.store.findUnique({
    where: { shop: session.shop },
    include: {
      programs: true
    }
  });

  if (!store || !store.onboardingCompleted) {
    const url = new URL(request.url);
    return redirect(`/app/onboarding${url.search}`);
  }

  // Dashboard Data Architecture (Mocked for UI visualization)
  // Can be easily swapped with real Prisma queries later
  
  const hasData = true; // Toggle to false to see the intended empty states!

  const dashboardData = {
    metrics: {
      totalRevenue: hasData ? 4248.50 : 0.00,
      totalRevenueChange: hasData ? 18.4 : null,
      orders: hasData ? 52 : 0,
      ordersChange: hasData ? 12.1 : null,
      clicks: hasData ? 1240 : 0,
      clicksChange: hasData ? -2.4 : null,
      conversionRate: hasData ? 4.1 : 0,
      conversionRateChange: hasData ? 0.5 : null,
    },
    programHealth: {
      status: "Active",
      totalCreators: hasData ? 24 : 0,
      activeCreators: hasData ? 21 : 0,
      pendingApproval: hasData ? 3 : 0,
      linkTracking: "Active",
      couponTracking: "Active"
    },
    commissions: {
      pending: hasData ? 248.50 : 0.00,
      approved: hasData ? 182.00 : 0.00,
      paid: hasData ? 1420.00 : 0.00
    },
    actionItems: hasData ? [
      { id: 1, text: "3 creators are waiting for approval.", action: "Review creators" },
      { id: 2, text: "$125.00 in commissions are ready to be paid.", action: "Review payouts" }
    ] : [],
    topCreators: hasData ? [
      { id: "c1", name: "Sarah Jenkins", sales: 2840, orders: 31, conversion: "4.8%", commission: 369 },
      { id: "c2", name: "Mike Ross", sales: 850, orders: 12, conversion: "3.2%", commission: 110.5 },
      { id: "c3", name: "Emma Watson", sales: 558.50, orders: 9, conversion: "5.1%", commission: 72.6 },
    ] : [],
    recentActivity: hasData ? [
      { id: 1, text: "Sarah joined your creator program", time: "2 hours ago" },
      { id: 2, text: "Order #1042 generated $84.00", time: "5 hours ago" },
      { id: 3, text: "Commission approved", time: "Yesterday" }
    ] : []
  };

  return { 
    storeName: session.shop.split(".")[0], 
    dashboardData,
    hasData,
    currency
  };
};

export default function Dashboard() {
  const { storeName, dashboardData, hasData, currency } = useLoaderData();
  const navigate = useNavigate();

  const [programFilter, setProgramFilter] = useState("standard");
  const [dateFilter, setDateFilter] = useState("30d");
  const [chartMetric, setChartMetric] = useState("revenue");
  const [isCopied, setIsCopied] = useState(false);

  const handleCopyLink = () => {
    navigator.clipboard.writeText("https://partnerloop.com/join/standard-8f31");
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency }).format(amount);
  };

  const formatNumber = (num) => {
    return new Intl.NumberFormat('en-US').format(num);
  };

  const getChartData = () => {
    switch(chartMetric) {
      case 'orders': return [
        { date: '1 Aug', value: 12 }, { date: '8 Aug', value: 24 }, { date: '15 Aug', value: 35 }, { date: '22 Aug', value: 40 }, { date: '29 Aug', value: 52 }
      ];
      case 'clicks': return [
        { date: '1 Aug', value: 145 }, { date: '8 Aug', value: 290 }, { date: '15 Aug', value: 420 }, { date: '22 Aug', value: 510 }, { date: '29 Aug', value: 680 }
      ];
      case 'commissions': return [
        { date: '1 Aug', value: 120 }, { date: '8 Aug', value: 240 }, { date: '15 Aug', value: 350 }, { date: '22 Aug', value: 400 }, { date: '29 Aug', value: 424 }
      ];
      case 'revenue':
      default: return [
        { date: '1 Aug', value: 1200 }, { date: '8 Aug', value: 2400 }, { date: '15 Aug', value: 3500 }, { date: '22 Aug', value: 4000 }, { date: '29 Aug', value: 4249 }
      ];
    }
  };

  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      let formattedValue = payload[0].value;
      if (chartMetric === 'revenue' || chartMetric === 'commissions') {
        formattedValue = formatCurrency(payload[0].value);
      } else {
        formattedValue = formatNumber(payload[0].value);
      }
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
            <Button onClick={() => {}}>View programs</Button>
            <Button variant="primary" disabled={true} accessibilityLabel="Creator registration coming soon">Invite creator</Button>
          </InlineStack>
        </InlineStack>

        {/* Filters */}
        <InlineStack gap="300">
          <Select 
            label="Program" 
            labelInline 
            options={[{label: 'Standard Creator Program', value: 'standard'}]} 
            value={programFilter}
            onChange={setProgramFilter}
          />
          <Select 
            label="Period" 
            labelInline 
            options={[
              {label: 'Today', value: 'today'},
              {label: 'Last 7 days', value: '7d'},
              {label: 'Last 30 days', value: '30d'},
              {label: 'This month', value: 'month'},
              {label: 'Last month', value: 'last_month'}
            ]} 
            value={dateFilter}
            onChange={setDateFilter}
          />
        </InlineStack>

        {/* Creator Signup Link */}
        {/* Creator Signup Link */}
        <div style={{ 
          boxShadow: '0 4px 20px rgba(0,0,0,0.08)', 
          borderRadius: 'var(--p-border-radius-300)', 
          backgroundColor: 'var(--p-color-bg-surface)', 
          borderLeft: '4px solid #733296',
          overflow: 'hidden'
        }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', background: 'linear-gradient(to right, var(--p-color-bg-surface), #f4eaff)' }}>
            <div style={{ flex: '1 1 50%', padding: 'var(--p-space-500)', minWidth: '350px' }}>
              <BlockStack gap="400">
                <InlineStack gap="300" blockAlign="center">
                  <div style={{ fontSize: '24px', fontWeight: '700', color: '#202223' }}>Creator signup link</div>
                  <Badge tone="success"><span style={{fontWeight: 'bold'}}>● Active</span></Badge>
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
                  border: '1px solid #d4b3e5',
                  boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.02)'
                }}>
                  <div style={{ paddingLeft: '8px' }}>
                    <div style={{ fontFamily: 'Consolas, Monaco, "Courier New", monospace', fontSize: '14px', color: '#202223', letterSpacing: '0.2px' }}>
                      https://partnerloop.com/join/standard-8f31
                    </div>
                  </div>
                  <button onClick={handleCopyLink} style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    backgroundColor: isCopied ? '#008060' : '#5b2175', 
                    color: 'white', 
                    border: 'none', 
                    borderRadius: 'var(--p-border-radius-150)', 
                    padding: '8px 16px', 
                    cursor: 'pointer', 
                    fontWeight: '600', 
                    fontSize: '13px',
                    boxShadow: 'inset 0 1px 0 0 rgba(255,255,255,0.1)',
                    transition: 'background-color 0.2s ease, width 0.2s ease'
                  }}>
                    <svg viewBox="0 0 20 20" fill="currentColor" width="16" height="16"><path d="M6 4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2h-2v2H6V6h2V4H6zm4-4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V2a2 2 0 0 0-2-2h-8zm0 2h8v10h-8V2z"/></svg>
                    {isCopied ? 'Copied!' : 'Copy link'}
                  </button>
                </div>
                </BlockStack>
                {(() => {
                  const creatorCount = hasData ? 26 : 0; // Using 48 as mock for active state, 0 for empty state
                  
                  let boxTheme = { bg: '#fdf7ff', iconBg: '#d4b3e5', iconColor: '#5b2175', title: 'Ready to grow?', desc: 'Share your signup link with creators to start building your network.' };
                  
                  if (creatorCount > 25) {
                    boxTheme = { bg: '#fdf7ff', iconBg: '#61d384', iconColor: '#ffffff', title: 'Your creator network is growing!', desc: `You now have ${creatorCount} creators registered in your program.` };
                  } else if (creatorCount > 0) {
                    boxTheme = { bg: '#fdf7ff', iconBg: '#ffc453', iconColor: '#b35f00', title: 'Grow your creator network', desc: `You have ${creatorCount} creators in your program. Keep sharing your signup link to grow your network.` };
                  }

                  return (
                    <div style={{ display: 'flex', border: '1px solid #f0e5f7', borderRadius: '8px', overflow: 'hidden', background: boxTheme.bg, marginTop: '8px' }}>
                      <div style={{ flex: '0 0 35%', padding: '20px', borderRight: '1px solid #f0e5f7', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                        <div style={{ fontSize: '36px', fontWeight: '800', color: '#5b2175', lineHeight: '1' }}>{creatorCount}</div>
                        <div style={{ fontSize: '11px', fontWeight: '700', color: '#6d7175', marginTop: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Creators Registered</div>
                        {creatorCount > 0 && (
                          <div style={{ marginTop: '12px' }}>
                            <a href="#" 
                              onMouseEnter={(e) => e.currentTarget.style.textDecoration = 'underline'}
                              onMouseLeave={(e) => e.currentTarget.style.textDecoration = 'none'}
                              style={{ color: '#5b2175', fontSize: '14px', fontWeight: '600', textDecoration: 'none' }}>
                              View creators →
                            </a>
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
               <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', backgroundImage: 'url(/cover-illustration.jpg)', backgroundSize: 'cover', backgroundPosition: 'center' }}></div>
            </div>
          </div>
        </div>

        {/* KPI Cards */}
        <InlineGrid columns={{xs: 1, sm: 2, md: 4}} gap="400">
          <MetricCard 
            title="Total revenue" 
            value={formatCurrency(dashboardData.metrics.totalRevenue)} 
            change={dashboardData.metrics.totalRevenueChange} 
            hasData={hasData}
          />
          <MetricCard 
            title="Orders" 
            value={formatNumber(dashboardData.metrics.orders)} 
            change={dashboardData.metrics.ordersChange} 
            hasData={hasData}
          />
          <MetricCard 
            title="Clicks" 
            value={formatNumber(dashboardData.metrics.clicks)} 
            change={dashboardData.metrics.clicksChange} 
            hasData={hasData}
          />
          <MetricCard 
            title="Conversion rate" 
            value={`${dashboardData.metrics.conversionRate}%`} 
            change={dashboardData.metrics.conversionRateChange} 
            hasData={hasData}
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
                      {label: 'Clicks', value: 'clicks'},
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
                        {chartMetric === 'revenue' || chartMetric === 'commissions' 
                          ? formatCurrency(chartMetric === 'revenue' ? dashboardData.metrics.totalRevenue : dashboardData.commissions.pending + dashboardData.commissions.approved + dashboardData.commissions.paid) 
                          : formatNumber(chartMetric === 'orders' ? dashboardData.metrics.orders : dashboardData.metrics.clicks)}
                      </Text>
                      <InlineStack gap="200" blockAlign="center">
                        <Text tone="success">↑ 18.4%</Text>
                        <Text tone="subdued">vs previous period</Text>
                      </InlineStack>
                    </BlockStack>
                    
                    <Box minHeight="200px" background="bg-surface" borderRadius="200" padding="400" borderWidth="025" borderColor="border">
                      <div style={{ width: '100%', height: 250 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={getChartData()} margin={{ top: 10, right: 0, left: 0, bottom: 0 }}>
                            <defs>
                              <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor="#733296" stopOpacity={0.3}/>
                                <stop offset="95%" stopColor="#733296" stopOpacity={0}/>
                              </linearGradient>
                            </defs>
                            <YAxis 
                              axisLine={false} 
                              tickLine={false} 
                              tick={{fill: 'var(--p-color-text-subdued)', fontSize: 12}} 
                              tickFormatter={(value) => chartMetric === 'revenue' || chartMetric === 'commissions' ? formatCurrency(value) : formatNumber(value)}
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
                              dataKey="value" 
                              stroke="#733296" 
                              strokeWidth={3}
                              fillOpacity={1} 
                              fill="url(#colorValue)" 
                              activeDot={{ r: 6, fill: '#733296', stroke: '#fff', strokeWidth: 2 }}
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </Box>
                    <div style={{ marginTop: '4px', padding: '12px 16px', background: '#fff8f1', borderRadius: '8px', borderLeft: '4px solid #f49342', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
                      <Text as="span">💡</Text>
                      <Text><span style={{color: '#b35f00', fontWeight: 'bold'}}>Tip:</span> Keep an eye on your performance trends around weekends. Creator-driven sales generally spike when they post on Saturdays!</Text>
                    </div>
                  </BlockStack>
                ) : (
                  <Box minHeight="300px" padding="400" background="bg-surface-secondary" borderRadius="200" borderWidth="025" borderColor="border">
                    <InlineStack align="center" blockAlign="center" style={{height: '100%'}}>
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
                    <Button variant="plain">View all creators →</Button>
                  </InlineStack>
                </Box>
                
                {dashboardData.topCreators.length > 0 ? (
                  <IndexTable
                    itemCount={dashboardData.topCreators.length}
                    headings={[
                      { title: 'Creator' },
                      { title: 'Sales', alignment: 'end' },
                      { title: 'Orders', alignment: 'end' },
                      { title: 'Conversion', alignment: 'end' },
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
                            <Text as="span" alignment="end">{creator.conversion}</Text>
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
                      <Button disabled={true}>Invite creator</Button>
                    </BlockStack>
                  </Box>
                )}
              </Card>
            </Box>
          </Layout.Section>
          
          <Layout.Section variant="oneThird">
            <BlockStack gap="400">
              {/* Program Health */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Program health</Text>
                  
                  <InlineStack align="space-between">
                    <Text>Program status</Text>
                    <Badge tone="success">Active</Badge>
                  </InlineStack>
                  <Divider />
                  
                  <InlineStack align="space-between">
                    <Text>Total creators</Text>
                    <Badge tone="info">{dashboardData.programHealth.totalCreators}</Badge>
                  </InlineStack>
                  <Divider />
                  
                  <InlineStack align="space-between">
                    <Text>Active creators</Text>
                    <Badge tone="success">{dashboardData.programHealth.activeCreators}</Badge>
                  </InlineStack>
                  <Divider />
                  
                  <InlineStack align="space-between">
                    <Text>Pending approval</Text>
                    <Badge tone="warning">{dashboardData.programHealth.pendingApproval}</Badge>
                  </InlineStack>
                  <Divider />
                  
                  <InlineStack align="space-between">
                    <Text>Link tracking</Text>
                    <Badge tone="success">Active</Badge>
                  </InlineStack>
                  <Divider />
                  
                  <InlineStack align="space-between">
                    <Text>Coupon tracking</Text>
                    <Badge tone="info">Active</Badge>
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
                      <Box paddingBlockStart="200">
                        <Button variant="plain">View all activity</Button>
                      </Box>
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

function MetricCard({ title, value, change, hasData }) {
  const isPositive = change > 0;
  const isNegative = change < 0;
  
  return (
    <Card>
      <BlockStack gap="200">
        <Text tone="subdued">{title}</Text>
        <Text variant="headingLg" as="p">{value}</Text>
        
        {hasData ? (
          <InlineStack gap="100" blockAlign="center">
            {change !== null ? (
              <>
                <Text tone={isPositive ? "success" : isNegative ? "critical" : "subdued"}>
                  {isPositive ? '↑' : isNegative ? '↓' : ''} {Math.abs(change)}%
                </Text>
                <Text tone="subdued" variant="bodySm">vs previous period</Text>
              </>
            ) : (
              <Text tone="subdued" variant="bodySm">No comparison data</Text>
            )}
          </InlineStack>
        ) : (
          <Text tone="subdued" variant="bodySm">No referral sales yet</Text>
        )}
      </BlockStack>
    </Card>
  );
}
