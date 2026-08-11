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
  Tabs,
  Checkbox,
  Modal,
  TextField,
  Divider,
  EmptyState,
  Banner,
} from "@shopify/polaris";
import { useCallback, useMemo, useState } from "react";
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

const STATUS_TONE = {
  PENDING: "warning",
  APPROVED: "info",
  PAID: "success",
  REJECTED: "critical",
};

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
    const result = await rejectCommissions({
      shop: session.shop,
      commissionIds,
      reason: formData.get("reason"),
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

  const [selected, setSelected] = useState(() => new Set());
  const [rejecting, setRejecting] = useState(null);
  const [reason, setReason] = useState("");

  const isBusy = navigation.state === "submitting";

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

  const selectedTab = Math.max(0, COMMISSION_TABS.findIndex((tab) => tab.id === status));

  const changeTab = useCallback(
    (index) => {
      setSelected(new Set());
      setSearchParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          next.set("status", COMMISSION_TABS[index].id);
          return next;
        },
        { replace: true, preventScrollReset: true },
      );
    },
    [setSearchParams],
  );

  const toggle = (id) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleCreator = (group) =>
    setSelected((current) => {
      const next = new Set(current);
      const ids = group.commissions.map((c) => c.id);
      const allOn = ids.every((id) => next.has(id));
      for (const id of ids) {
        if (allOn) next.delete(id);
        else next.add(id);
      }
      return next;
    });

  const run = (intent, ids, extra = {}) =>
    submit({ intent, commissionIds: ids.join(","), ...extra }, { method: "post" });

  const selectedTotal = creators
    .flatMap((group) => group.commissions)
    .filter((commission) => selected.has(commission.id))
    .reduce((sum, commission) => sum + commission.amount, 0);

  return (
    <Page fullWidth>
      <TitleBar title="Commissions" />
      <BlockStack gap="400">
        <InlineStack align="space-between" blockAlign="center">
          <BlockStack gap="100">
            <Text variant="headingXl" as="h1">Commissions</Text>
            <Text tone="subdued">
              Review what creators have earned, then group approved commissions into a payout.
            </Text>
          </BlockStack>
          <BlockStack gap="050" inlineAlign="end">
            <Text variant="headingLg" as="p">{formatMoney(total)}</Text>
            <Text tone="subdued" variant="bodySm">
              {count} {status.toLowerCase()} commission{count === 1 ? "" : "s"}
            </Text>
          </BlockStack>
        </InlineStack>

        {selected.size > 0 && (
          <Banner tone="info">
            <InlineStack align="space-between" blockAlign="center" gap="400">
              <Text>
                {selected.size} selected · {formatMoney(selectedTotal)}
              </Text>
              <InlineStack gap="200">
                {status === "PENDING" && (
                  <>
                    <Button
                      variant="primary"
                      disabled={isBusy}
                      onClick={() => run("approve", [...selected])}
                    >
                      Approve selected
                    </Button>
                    <Button
                      tone="critical"
                      disabled={isBusy}
                      onClick={() => setRejecting([...selected])}
                    >
                      Reject selected
                    </Button>
                  </>
                )}
                <Button onClick={() => setSelected(new Set())}>Clear</Button>
              </InlineStack>
            </InlineStack>
          </Banner>
        )}

        <Card padding="0">
          <Tabs tabs={tabs} selected={selectedTab} onSelect={changeTab} />

          {creators.length === 0 ? (
            <Box padding="400">
              <EmptyState
                heading={`No ${status.toLowerCase()} commissions`}
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  {status === "PENDING"
                    ? "Commissions appear here automatically when a referred order comes in."
                    : "Nothing in this state yet."}
                </p>
              </EmptyState>
            </Box>
          ) : (
            <BlockStack gap="0">
              {creators.map((group) => {
                const ids = group.commissions.map((c) => c.id);
                const allSelected = ids.every((id) => selected.has(id));

                return (
                  <Box
                    key={group.creatorId}
                    padding="400"
                    borderBlockStartWidth="025"
                    borderColor="border"
                  >
                    <BlockStack gap="300">
                      <InlineStack align="space-between" blockAlign="center" gap="400">
                        <InlineStack gap="300" blockAlign="center">
                          {status === "PENDING" && (
                            <Checkbox
                              label=""
                              labelHidden
                              checked={allSelected}
                              onChange={() => toggleCreator(group)}
                            />
                          )}
                          <BlockStack gap="050">
                            <Text variant="headingMd" as="h2">{group.name}</Text>
                            <Text tone="subdued" variant="bodySm">
                              {group.commissions.length} commission
                              {group.commissions.length === 1 ? "" : "s"} · {group.programName} ·{" "}
                              <code>{group.referralCode}</code>
                            </Text>
                            {balances[group.creatorId] > 0 && (
                              <Text tone="critical" variant="bodySm">
                                Owes back {formatMoney(balances[group.creatorId])} from refunds on
                                commissions already paid
                              </Text>
                            )}
                          </BlockStack>
                        </InlineStack>

                        <InlineStack gap="300" blockAlign="center">
                          <Text variant="headingMd" as="p">{formatMoney(group.total)}</Text>
                          {status === "PENDING" && (
                            <Button
                              variant="primary"
                              disabled={isBusy}
                              onClick={() => run("approve", ids)}
                            >
                              Approve all
                            </Button>
                          )}
                          {status === "APPROVED" && (
                            <Button
                              variant="primary"
                              disabled={isBusy}
                              onClick={() =>
                                run("payout", ids.filter((id, i) => !group.commissions[i].payoutId), {
                                  creatorId: group.creatorId,
                                })
                              }
                            >
                              Create payout
                            </Button>
                          )}
                        </InlineStack>
                      </InlineStack>

                      <Divider />

                      <BlockStack gap="200">
                        {group.commissions.map((commission) => (
                          <InlineStack
                            key={commission.id}
                            align="space-between"
                            blockAlign="center"
                            gap="400"
                            wrap={false}
                          >
                            <InlineStack gap="300" blockAlign="center" wrap={false}>
                              {status === "PENDING" && (
                                <Checkbox
                                  label=""
                                  labelHidden
                                  checked={selected.has(commission.id)}
                                  onChange={() => toggle(commission.id)}
                                />
                              )}
                              <Text fontWeight="medium">{commission.orderNumber ?? "—"}</Text>
                              <Text tone="subdued" variant="bodySm">
                                order {formatMoney(commission.orderAmount)}
                              </Text>
                              {commission.heldUntilFuture && (
                                <Badge tone="attention">
                                  {`Hold until ${new Date(commission.eligibleAt).toLocaleDateString()}`}
                                </Badge>
                              )}
                              {commission.rejectionReason && (
                                <Text tone="subdued" variant="bodySm">
                                  {commission.rejectionReason}
                                </Text>
                              )}
                            </InlineStack>

                            <InlineStack gap="300" blockAlign="center" wrap={false}>
                              {commission.adjusted && (
                                <Text tone="subdued" variant="bodySm">
                                  <s>{formatMoney(commission.originalAmount)}</s>{" "}
                                  {commission.adjustments
                                    .map((a) => `${a.amount > 0 ? "+" : ""}${a.amount} ${a.reason}`)
                                    .join(" · ")}
                                </Text>
                              )}
                              <Text fontWeight="semibold">{formatMoney(commission.amount)}</Text>
                              <Badge tone={STATUS_TONE[commission.status]}>
                                {commission.status.charAt(0) + commission.status.slice(1).toLowerCase()}
                              </Badge>
                              {(status === "PENDING" || status === "APPROVED") &&
                                !commission.payoutId && (
                                  <Button
                                    size="slim"
                                    tone="critical"
                                    disabled={isBusy}
                                    onClick={() => setRejecting([commission.id])}
                                  >
                                    Reject
                                  </Button>
                                )}
                            </InlineStack>
                          </InlineStack>
                        ))}
                      </BlockStack>
                    </BlockStack>
                  </Box>
                );
              })}
            </BlockStack>
          )}
        </Card>
      </BlockStack>

      <Modal
        open={Boolean(rejecting)}
        onClose={() => { setRejecting(null); setReason(""); }}
        title={`Reject ${rejecting?.length === 1 ? "commission" : `${rejecting?.length} commissions`}`}
        primaryAction={{
          content: "Reject",
          destructive: true,
          disabled: !reason.trim() || isBusy,
          onAction: () => {
            run("reject", rejecting, { reason });
            setRejecting(null);
            setReason("");
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => { setRejecting(null); setReason(""); } },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text>
              The creator keeps credit for generating the order — only their entitlement to be paid
              for it is withdrawn. Attribution and reporting are unaffected.
            </Text>
            <TextField
              label="Reason"
              value={reason}
              onChange={setReason}
              autoComplete="off"
              multiline={2}
              placeholder="Order refunded, self-referral, duplicate…"
              helpText="Recorded against the commission so the decision can be explained later."
              requiredIndicator
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
