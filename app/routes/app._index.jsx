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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { TitleBar } from "@shopify/app-bridge-react";
import { useState, useCallback } from "react";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  
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
    hasData 
  };
};

export default function Dashboard() {
  const { storeName, dashboardData, hasData } = useLoaderData();
  const navigate = useNavigate();

  const [programFilter, setProgramFilter] = useState("standard");
  const [dateFilter, setDateFilter] = useState("30d");

  const formatCurrency = (amount) => {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
  };

  const formatNumber = (num) => {
    return new Intl.NumberFormat('en-US').format(num);
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
                <Text variant="headingMd" as="h2">Revenue performance</Text>
                
                {hasData ? (
                  <Box minHeight="300px" background="bg-surface-secondary" borderRadius="200" padding="400" borderWidth="025" borderColor="border">
                    <InlineStack align="center" blockAlign="center" style={{height: '100%'}}>
                      <Text tone="subdued">[ Chart UI Framework Placeholder ]</Text>
                    </InlineStack>
                  </Box>
                ) : (
                  <Box minHeight="300px" padding="400" background="bg-surface-secondary" borderRadius="200" borderWidth="025" borderColor="border">
                    <InlineStack align="center" blockAlign="center" style={{height: '100%'}}>
                      <BlockStack gap="200" align="center" inlineAlign="center">
                        <Text variant="headingSm" as="h3">No referral sales yet</Text>
                        <Text tone="subdued">Your revenue performance will appear here once creators start generating sales.</Text>
                      </BlockStack>
                    </InlineStack>
                  </Box>
                )}
              </BlockStack>
            </Card>

            <Box paddingBlockStart="400">
              {/* Action Items */}
              <Card>
                <BlockStack gap="400">
                  <Text variant="headingMd" as="h2">Action items</Text>
                  {dashboardData.actionItems.length > 0 ? (
                    <BlockStack gap="300">
                      {dashboardData.actionItems.map(item => (
                        <InlineStack key={item.id} align="space-between" blockAlign="center">
                          <Text>{item.text}</Text>
                          <Button size="small">{item.action}</Button>
                        </InlineStack>
                      ))}
                    </BlockStack>
                  ) : (
                    <Box paddingBlock="200">
                      <Text tone="subdued">You're all caught up.</Text>
                    </Box>
                  )}
                </BlockStack>
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
                    <Text fontWeight="semibold">{dashboardData.programHealth.totalCreators}</Text>
                  </InlineStack>
                  <Divider />
                  
                  <InlineStack align="space-between">
                    <Text>Active creators</Text>
                    <Text fontWeight="semibold">{dashboardData.programHealth.activeCreators}</Text>
                  </InlineStack>
                  <Divider />
                  
                  <InlineStack align="space-between">
                    <Text>Pending approval</Text>
                    <Text fontWeight="semibold">{dashboardData.programHealth.pendingApproval}</Text>
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
                  
                  <InlineStack align="space-between">
                    <Text tone="subdued">Pending</Text>
                    <Text fontWeight="semibold">{formatCurrency(dashboardData.commissions.pending)}</Text>
                  </InlineStack>
                  
                  <InlineStack align="space-between">
                    <Text tone="subdued">Approved</Text>
                    <Text fontWeight="semibold">{formatCurrency(dashboardData.commissions.approved)}</Text>
                  </InlineStack>
                  
                  <InlineStack align="space-between">
                    <Text tone="subdued">Paid</Text>
                    <Text fontWeight="semibold">{formatCurrency(dashboardData.commissions.paid)}</Text>
                  </InlineStack>
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>

        {/* Bottom Section: Top Creators & Recent Activity */}
        <Layout>
          <Layout.Section>
            <Card padding="0">
              <Box padding="400">
                <Text variant="headingMd" as="h2">Top creators</Text>
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
                          <Text fontWeight="bold" as="span">{creator.name}</Text>
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
                          <Text as="span" alignment="end">{formatCurrency(creator.commission)}</Text>
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
          </Layout.Section>
          
          <Layout.Section variant="oneThird">
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Recent activity</Text>
                
                {dashboardData.recentActivity.length > 0 ? (
                  <BlockStack gap="400">
                    {dashboardData.recentActivity.map(activity => (
                      <BlockStack key={activity.id} gap="100">
                        <Text>{activity.text}</Text>
                        <Text tone="subdued" variant="bodySm">{activity.time}</Text>
                      </BlockStack>
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
