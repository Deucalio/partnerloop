import { useLoaderData, useSearchParams, useSubmit, useNavigation } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  Text,
  InlineStack,
  Button,
  Badge,
  Box,
  IndexTable,
  Tabs,
  Avatar,
  EmptyState,
} from "@shopify/polaris";
import { useCallback, useMemo } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { TitleBar } from "@shopify/app-bridge-react";

const TABS = [
  { id: "ALL", content: "All" },
  { id: "PENDING", content: "Pending" },
  { id: "ACTIVE", content: "Active" },
  { id: "INACTIVE", content: "Inactive" },
  { id: "REJECTED", content: "Rejected" },
];

const STATUS_TONE = {
  PENDING: "warning",
  ACTIVE: "success",
  INACTIVE: undefined,
  REJECTED: "critical",
};

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "ALL";

  const response = await admin.graphql(
    `#graphql
    query {
      shop {
        currencyCode
      }
    }`,
  );
  const data = await response.json();
  const currency = data.data?.shop?.currencyCode || "USD";

  const creators = await prisma.creator.findMany({
    where: {
      program: { shopId: session.shop },
      ...(status === "ALL" ? {} : { status }),
    },
    include: {
      // Identity lives on CreatorAccount so one person has a single login
      // across every program they join.
      account: { select: { firstName: true, lastName: true, email: true } },
      program: { select: { name: true } },
      _count: { select: { referrals: true } },
      commissions: { select: { amount: true, status: true } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });

  const counts = await prisma.creator.groupBy({
    by: ["status"],
    where: { program: { shopId: session.shop } },
    _count: { _all: true },
  });

  return {
    currency,
    status,
    counts: Object.fromEntries(counts.map((row) => [row.status, row._count._all])),
    creators: creators.map((creator) => ({
      id: creator.id,
      name: `${creator.account.firstName} ${creator.account.lastName}`.trim(),
      email: creator.account.email,
      referralCode: creator.referralCode,
      status: creator.status,
      programName: creator.program.name,
      referrals: creator._count.referrals,
      // Everything not yet paid out is what the merchant still owes.
      outstanding: creator.commissions
        .filter((c) => c.status === "PENDING" || c.status === "APPROVED")
        .reduce((sum, c) => sum + c.amount, 0),
      joinedAt: creator.createdAt.toISOString(),
    })),
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const creatorId = formData.get("creatorId");
  const intent = formData.get("intent");

  const nextStatus = {
    approve: "ACTIVE",
    reject: "REJECTED",
    deactivate: "INACTIVE",
    reactivate: "ACTIVE",
  }[intent];

  if (!creatorId || !nextStatus) {
    return { ok: false, error: "Unknown action" };
  }

  // updateMany (not update) so the shop ownership filter is enforced by the
  // query itself — a creator id from another shop simply matches zero rows.
  const { count } = await prisma.creator.updateMany({
    where: { id: creatorId, program: { shopId: session.shop } },
    data: {
      status: nextStatus,
      ...(nextStatus === "ACTIVE" ? { approvedAt: new Date() } : {}),
    },
  });

  return { ok: count === 1 };
};

export default function Creators() {
  const { creators, counts, status, currency } = useLoaderData();
  const [, setSearchParams] = useSearchParams();
  const submit = useSubmit();
  const navigation = useNavigation();

  const isBusy = navigation.state === "submitting";

  const selectedTab = Math.max(
    0,
    TABS.findIndex((tab) => tab.id === status),
  );

  const tabs = useMemo(
    () =>
      TABS.map((tab) => ({
        ...tab,
        badge: tab.id === "ALL" ? undefined : String(counts[tab.id] ?? 0),
      })),
    [counts],
  );

  const handleTabChange = useCallback(
    (index) => {
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set("status", TABS[index].id);
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  const act = useCallback(
    (creatorId, intent) => submit({ creatorId, intent }, { method: "post" }),
    [submit],
  );

  const formatCurrency = (amount) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);

  return (
    <Page fullWidth>
      <TitleBar title="Creators" />
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text variant="headingXl" as="h1">Creators</Text>
          <Text tone="subdued">
            Review applications and manage the creators promoting your store.
          </Text>
        </BlockStack>

        <Card padding="0">
          <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabChange} />

          {creators.length === 0 ? (
            <Box padding="400">
              <EmptyState
                heading={status === "ALL" ? "No creators yet" : `No ${status.toLowerCase()} creators`}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Share your program signup link to start receiving creator
                  applications. New applications land here for approval.
                </p>
              </EmptyState>
            </Box>
          ) : (
            <IndexTable
              itemCount={creators.length}
              selectable={false}
              headings={[
                { title: "Creator" },
                { title: "Program" },
                { title: "Referral code" },
                { title: "Referrals", alignment: "end" },
                { title: "Unpaid", alignment: "end" },
                { title: "Status" },
                { title: "Actions" },
              ]}
            >
              {creators.map((creator, index) => (
                <IndexTable.Row id={creator.id} key={creator.id} position={index}>
                  <IndexTable.Cell>
                    <InlineStack gap="300" blockAlign="center" wrap={false}>
                      <Avatar size="sm" customer name={creator.name} />
                      <BlockStack gap="050">
                        <Text fontWeight="bold" as="span">{creator.name}</Text>
                        <Text tone="subdued" variant="bodySm">{creator.email}</Text>
                      </BlockStack>
                    </InlineStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span">{creator.programName}</Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" fontWeight="medium">
                      <code>{creator.referralCode}</code>
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" alignment="end">{creator.referrals}</Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" alignment="end">{formatCurrency(creator.outstanding)}</Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={STATUS_TONE[creator.status]}>
                      {creator.status.charAt(0) + creator.status.slice(1).toLowerCase()}
                    </Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <InlineStack gap="200" wrap={false}>
                      {creator.status === "PENDING" && (
                        <>
                          <Button
                            variant="primary"
                            size="slim"
                            disabled={isBusy}
                            onClick={() => act(creator.id, "approve")}
                          >
                            Approve
                          </Button>
                          <Button
                            size="slim"
                            tone="critical"
                            disabled={isBusy}
                            onClick={() => act(creator.id, "reject")}
                          >
                            Reject
                          </Button>
                        </>
                      )}
                      {creator.status === "ACTIVE" && (
                        <Button
                          size="slim"
                          disabled={isBusy}
                          onClick={() => act(creator.id, "deactivate")}
                        >
                          Deactivate
                        </Button>
                      )}
                      {(creator.status === "INACTIVE" || creator.status === "REJECTED") && (
                        <Button
                          size="slim"
                          disabled={isBusy}
                          onClick={() => act(creator.id, "reactivate")}
                        >
                          Reactivate
                        </Button>
                      )}
                    </InlineStack>
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>
    </Page>
  );
}
