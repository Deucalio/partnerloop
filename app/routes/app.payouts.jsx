import { useLoaderData, useSubmit, useNavigation } from "react-router";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Button,
  Badge,
  Box,
  IndexTable,
  Modal,
  TextField,
  EmptyState,
} from "@shopify/polaris";
import { useCallback, useState } from "react";
import { authenticate } from "../shopify.server";
import { TitleBar } from "@shopify/app-bridge-react";
import { getPayouts, markPayoutPaid } from "../services/commissions.server";

const STATUS_TONE = { PENDING: "warning", PROCESSING: "info", PAID: "success", FAILED: "critical" };

export const loader = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);

  const response = await admin.graphql(`#graphql
    query { shop { currencyCode } }`);
  const currency = (await response.json()).data?.shop?.currencyCode || "USD";

  return { payouts: await getPayouts({ shop: session.shop }), currency };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const result = await markPayoutPaid({
    shop: session.shop,
    payoutId: formData.get("payoutId"),
    method: formData.get("method"),
    reference: formData.get("reference"),
    note: formData.get("note"),
  });

  return result.ok
    ? { ok: true, message: "Payout marked as paid." }
    : { ok: false, message: result.error };
};

export default function Payouts() {
  const { payouts, currency } = useLoaderData();
  const submit = useSubmit();
  const navigation = useNavigation();

  const [paying, setPaying] = useState(null);
  const [method, setMethod] = useState("Bank transfer");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  const isBusy = navigation.state === "submitting";

  const formatMoney = useCallback(
    (amount) => new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount),
    [currency],
  );

  const formatDate = (value) =>
    value
      ? new Intl.DateTimeFormat("en-US", {
          day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit",
        }).format(new Date(value))
      : "—";

  const confirmPaid = () => {
    submit(
      { payoutId: paying.id, method, reference, note },
      { method: "post" },
    );
    setPaying(null);
    setReference("");
    setNote("");
  };

  return (
    <Page fullWidth>
      <TitleBar title="Payouts" />
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text variant="headingXl" as="h1">Payouts</Text>
          <Text tone="subdued">
            Payments to creators, each covering a batch of approved commissions. Payments are made
            outside PartnerLoop; recording them here is what gives you the audit trail.
          </Text>
        </BlockStack>

        <Card padding="0">
          {payouts.length === 0 ? (
            <Box padding="400">
              <EmptyState
                heading="No payouts yet"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
              >
                <p>
                  Approve a creator&apos;s commissions, then use <b>Create payout</b> on the
                  Commissions page to group them into a payment.
                </p>
              </EmptyState>
            </Box>
          ) : (
            <IndexTable
              itemCount={payouts.length}
              selectable={false}
              headings={[
                { title: "Payout" },
                { title: "Creator" },
                { title: "Commissions", alignment: "end" },
                { title: "Amount", alignment: "end" },
                { title: "Method / reference" },
                { title: "Paid" },
                { title: "Status" },
                { title: "" },
              ]}
            >
              {payouts.map((payout, index) => (
                <IndexTable.Row id={payout.id} key={payout.id} position={index}>
                  <IndexTable.Cell>
                    <Text fontWeight="bold" as="span">{payout.label}</Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <BlockStack gap="050">
                      <Text as="span">{payout.creatorName}</Text>
                      <Text tone="subdued" variant="bodySm"><code>{payout.referralCode}</code></Text>
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" alignment="end">{payout.commissionCount}</Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" alignment="end" fontWeight="semibold">
                      {formatMoney(payout.amount)}
                    </Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <BlockStack gap="050">
                      <Text as="span">{payout.method ?? "—"}</Text>
                      {payout.reference && (
                        <Text tone="subdued" variant="bodySm"><code>{payout.reference}</code></Text>
                      )}
                    </BlockStack>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Text as="span" tone="subdued">{formatDate(payout.paidAt)}</Text>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    <Badge tone={STATUS_TONE[payout.status]}>
                      {payout.status.charAt(0) + payout.status.slice(1).toLowerCase()}
                    </Badge>
                  </IndexTable.Cell>
                  <IndexTable.Cell>
                    {payout.status !== "PAID" && (
                      <Button
                        size="slim"
                        variant="primary"
                        disabled={isBusy}
                        onClick={() => {
                          setPaying(payout);
                          setMethod(payout.method || "Bank transfer");
                          setReference(payout.reference || "");
                          setNote(payout.note || "");
                        }}
                      >
                        Mark as paid
                      </Button>
                    )}
                  </IndexTable.Cell>
                </IndexTable.Row>
              ))}
            </IndexTable>
          )}
        </Card>
      </BlockStack>

      <Modal
        open={Boolean(paying)}
        onClose={() => setPaying(null)}
        title={`Mark ${paying?.label} as paid`}
        primaryAction={{ content: "Mark as paid", disabled: isBusy, onAction: confirmPaid }}
        secondaryActions={[{ content: "Cancel", onAction: () => setPaying(null) }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            <Text>
              Confirming that {formatMoney(paying?.amount ?? 0)} has been sent to{" "}
              <b>{paying?.creatorName}</b>. Its {paying?.commissionCount} commission
              {paying?.commissionCount === 1 ? "" : "s"} will be marked paid and can never be
              included in another payout.
            </Text>
            <TextField
              label="Payment method"
              value={method}
              onChange={setMethod}
              autoComplete="off"
              placeholder="Bank transfer, Wise, PayPal…"
            />
            <TextField
              label="Payment reference"
              value={reference}
              onChange={setReference}
              autoComplete="off"
              placeholder="TRX-92838192"
              helpText="Your bank or provider's transaction id — this is what answers “did I actually pay this?” months from now."
            />
            <TextField
              label="Note (optional)"
              value={note}
              onChange={setNote}
              autoComplete="off"
              multiline={2}
            />
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
