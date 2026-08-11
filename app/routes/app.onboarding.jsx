import { useState } from "react";
import { redirect, useSubmit } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  Page,
  Card,
  BlockStack,
  Text,
  Select,
  TextField,
  Button,
  InlineStack,
  Box,
  InlineGrid,
  Icon,
  ProgressBar
} from "@shopify/polaris";
import { LinkIcon, DiscountIcon } from "@shopify/polaris-icons";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const store = await prisma.store.findUnique({
    where: { shop: session.shop },
  });

  if (store?.onboardingCompleted) {
    const url = new URL(request.url);
    return redirect(`/app${url.search}`);
  }

  return null;
};

export const action = async ({ request }) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const industry = formData.get("industry");
  const businessDescription = formData.get("businessDescription") || "";
  const commissionType = formData.get("commissionType");
  const commissionAmount = parseFloat(formData.get("commissionAmount"));
  const couponTrackingEnabled = formData.get("couponTrackingEnabled") === "true";

  if (!industry || !commissionType || isNaN(commissionAmount)) {
    return new Response(JSON.stringify({ error: "Missing required fields" }), { status: 400 });
  }

  // Mirrored onto the Store so the creators-panel can format commission amounts
  // without Admin API access of its own.
  const shopResponse = await admin.graphql(`#graphql
    query {
      shop {
        currencyCode
      }
    }`);
  const shopData = await shopResponse.json();
  const currencyCode = shopData.data?.shop?.currencyCode || "USD";

  await prisma.$transaction(async (tx) => {
    await tx.store.upsert({
      where: { shop: session.shop },
      update: { onboardingCompleted: true, currencyCode },
      create: { shop: session.shop, onboardingCompleted: true, currencyCode },
    });

    await tx.businessInfo.upsert({
      where: { shopId: session.shop },
      update: { industry, businessDescription },
      create: { shopId: session.shop, industry, businessDescription },
    });

    const program = await tx.program.create({
      data: {
        shopId: session.shop,
        name: "Standard Creator Commission",
        isDefault: true,
      },
    });

    await tx.commissionConfig.create({
      data: {
        programId: program.id,
        type: commissionType,
        amount: commissionAmount,
      },
    });

    await tx.trackingConfig.create({
      data: {
        programId: program.id,
        linkTrackingEnabled: true,
        couponTrackingEnabled,
      },
    });
  });

  const url = new URL(request.url);
  return redirect(`/app${url.search}`);
};

export default function Onboarding() {
  const [step, setStep] = useState(1);
  const submit = useSubmit();
  
  // Step 1
  const [industry, setIndustry] = useState("");
  const [businessDescription, setBusinessDescription] = useState("");
  
  // Step 2
  const [commissionType, setCommissionType] = useState("PERCENTAGE");
  const [commissionAmount, setCommissionAmount] = useState("13");
  
  // Step 3
  const [couponTrackingEnabled, setCouponTrackingEnabled] = useState(false);

  const handleNext = () => {
    if (step === 1 && !industry) return;
    setStep((s) => s + 1);
  };

  const handleBack = () => {
    setStep((s) => s - 1);
  };

  const handleFinish = () => {
    submit(
      {
        industry,
        businessDescription,
        commissionType,
        commissionAmount,
        couponTrackingEnabled: couponTrackingEnabled.toString(),
      },
      { method: "POST" }
    );
  };

  const industryOptions = [
    { label: "Select an industry", value: "" },
    { label: "Apparel & Accessories", value: "Apparel & Accessories" },
    { label: "Health & Beauty", value: "Health & Beauty" },
    { label: "Home & Garden", value: "Home & Garden" },
    { label: "Electronics", value: "Electronics" },
    { label: "Food & Beverage", value: "Food & Beverage" },
    { label: "Other", value: "Other" },
  ];

  // Custom visual tokens matching the vibrant SaaS look
  const BRAND_COLOR = "#5c35ff"; // Vibrant purple-blue
  const BRAND_LIGHT = "#f2efff"; // Very light tint of brand
  const BRAND_BORDER = "#d5ccff"; // Subtle border for badges
  const RADIO_BLUE = "#007cff"; // Vibrant blue for the radio button
  const BRAND_BORDER_COLOR = "#450f9a"; // Darker purple for border emphasis

  const selectedCardStyle = {
    cursor: "pointer", 
    borderRadius: '8px', 
    border: `1px solid ${BRAND_COLOR}`,
    boxShadow: `0 0 0 2px rgba(92, 53, 255, 0.08), 0 4px 12px rgba(92, 53, 255, 0.1)`,
    padding: '24px',
    transition: 'all 0.2s ease',
    backgroundColor: '#ffffff'
  };

  const unselectedCardStyle = {
    cursor: "pointer", 
    borderRadius: '8px', 
    border: '1px solid #d4d6d8',
    boxShadow: 'none',
    padding: '24px',
    transition: 'all 0.2s ease',
    backgroundColor: '#ffffff'
  };

  const selectedRadioStyle = {
    width: '20px', 
    height: '20px', 
    borderRadius: '50%', 
    border: `1px solid ${RADIO_BLUE}`,
    background: RADIO_BLUE,
    backgroundClip: 'content-box',
    padding: '3px',
    transition: 'all 0.2s ease'
  };

  const unselectedRadioStyle = {
    width: '20px', 
    height: '20px', 
    borderRadius: '50%', 
    border: '1px solid #8c9196',
    background: 'transparent',
    transition: 'all 0.2s ease',
    padding: '3px',
  };

  return (
    <Page narrowWidth>
      <Box paddingBlockEnd="800" paddingBlockStart="200">
        <BlockStack gap="600">
          <BlockStack gap="400" align="center" inlineAlign="center">
            <Text variant="headingXl" as="h1" alignment="center">
              Launch your creator program
            </Text>
            <Box paddingBlockStart="200" paddingBlockEnd="200" minWidth="250px">
              <ProgressBar progress={(step / 3) * 100} size="small" tone="primary" />
            </Box>
          </BlockStack>
          
          <Box paddingBlockStart="200">
            <InlineStack align="space-between" blockAlign="center" gap="400">
              {[1, 2, 3].map((s) => (
                <div 
                  key={s} 
                  style={{ 
                    flex: 1, 
                    borderBottom: step >= s ? `3px solid ${BRAND_BORDER_COLOR}` : '3px solid var(--p-color-border-subdued)', 
                    paddingBottom: '12px',
                    transition: 'all 0.3s ease',
                    opacity: step >= s ? 1 : 0.6
                  }}
                >
                  <Text 
                    fontWeight={step === s ? "bold" : "medium"} 
                    tone="base"
                    alignment="center"
                  >
                    {s === 1 ? "General info" : s === 2 ? "Commission rule" : "Tracking setup"}
                  </Text>
                </div>
              ))}
            </InlineStack>
          </Box>
        </BlockStack>
      </Box>

      {step === 1 && (
        <Card>
          <BlockStack gap="500">
            <BlockStack gap="200">
              <Text variant="headingLg" as="h2">About your business</Text>
              <Text tone="subdued">Tell us about your business to help tailor your creator program.</Text>
            </BlockStack>
            
            <BlockStack gap="400">
              <Select
                label="Industry *"
                options={industryOptions}
                value={industry}
                onChange={setIndustry}
              />
              
              <TextField
                label="Business description"
                value={businessDescription}
                onChange={setBusinessDescription}
                multiline={3}
                maxLength={1000}
                showCharacterCount
                placeholder="Briefly describe what you sell..."
                autoComplete="off"
              />
            </BlockStack>
            
            <Box paddingBlockStart="400">
              <InlineStack align="end">
                <Button variant="primary" onClick={handleNext} disabled={!industry}>
                  Continue
                </Button>
              </InlineStack>
            </Box>
          </BlockStack>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <BlockStack gap="600">
            <BlockStack gap="200">
              <Text variant="headingLg" as="h2">How do you want to reward affiliates?</Text>
            </BlockStack>
            
            <BlockStack gap="300">
              {/* Option 1 */}
              <div 
                onClick={() => setCommissionType("PERCENTAGE")}
                style={commissionType === "PERCENTAGE" ? selectedCardStyle : unselectedCardStyle}
              >
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <InlineStack gap="200" blockAlign="center">
                      <Text variant="headingMd" as="h3">Percent of sale</Text>
                      <div style={{
                        background: BRAND_LIGHT,
                        border: `1px solid ${BRAND_BORDER}`,
                        borderRadius: '20px',
                        padding: '2px 10px',
                        color: BRAND_COLOR,
                        fontSize: '12px',
                        fontWeight: '500'
                      }}>
                        Best fit
                      </div>
                    </InlineStack>
                    <Text tone="subdued">Affiliates earn a percentage of each sale</Text>
                  </BlockStack>
                  <div style={commissionType === "PERCENTAGE" ? selectedRadioStyle : unselectedRadioStyle} />
                </InlineStack>
              </div>

              {/* Option 2 */}
              <div 
                onClick={() => setCommissionType("FIXED_PER_ORDER")}
                style={commissionType === "FIXED_PER_ORDER" ? selectedCardStyle : unselectedCardStyle}
              >
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h3">Fixed amount per order</Text>
                    <Text tone="subdued">Flat amount for each order</Text>
                  </BlockStack>
                  <div style={commissionType === "FIXED_PER_ORDER" ? selectedRadioStyle : unselectedRadioStyle} />
                </InlineStack>
              </div>

              {/* Option 3 */}
              <div 
                onClick={() => setCommissionType("FIXED_PER_ITEM")}
                style={commissionType === "FIXED_PER_ITEM" ? selectedCardStyle : unselectedCardStyle}
              >
                <InlineStack align="space-between" blockAlign="center">
                  <BlockStack gap="100">
                    <Text variant="headingMd" as="h3">Fixed amount per item</Text>
                    <Text tone="subdued">Flat amount per product sold</Text>
                  </BlockStack>
                  <div style={commissionType === "FIXED_PER_ITEM" ? selectedRadioStyle : unselectedRadioStyle} />
                </InlineStack>
              </div>
            </BlockStack>

            <Box paddingBlockStart="200">
              <TextField
                label={commissionType === "PERCENTAGE" ? "Commission rate" : "Commission amount"}
                type="number"
                value={commissionAmount}
                onChange={setCommissionAmount}
                suffix={commissionType === "PERCENTAGE" ? "%" : "USD"}
                autoComplete="off"
              />
            </Box>

            <Box paddingBlockStart="400">
              <InlineStack align="space-between">
                <Button onClick={handleBack}>Back</Button>
                <InlineStack gap="300">
                  <Button variant="tertiary" onClick={handleNext}>Skip</Button>
                  <Button variant="primary" onClick={handleNext}>Continue</Button>
                </InlineStack>
              </InlineStack>
            </Box>
          </BlockStack>
        </Card>
      )}

      {step === 3 && (
        <BlockStack gap="500">
          <BlockStack gap="200">
            <Text variant="headingLg" as="h2">Tracking setup</Text>
            <Text tone="subdued">Choose how PartnerLoop should track partner sales.</Text>
          </BlockStack>

          <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
            {/* Card 1 */}
            <div style={{ 
              borderRadius: '8px', 
              border: `1px solid ${BRAND_COLOR}`,
              boxShadow: `0 0 0 2px rgba(92, 53, 255, 0.08), 0 4px 12px rgba(92, 53, 255, 0.1)`,
              padding: '24px',
              backgroundColor: '#ffffff'
            }}>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{ display: 'flex', color: BRAND_COLOR }}>
                      <Icon source={LinkIcon} tone="base" />
                    </div>
                    <Text variant="headingSm" as="h3">Link tracking</Text>
                  </InlineStack>
                  <div style={{
                    background: '#e3f1e9',
                    border: `1px solid #b6dbce`,
                    borderRadius: '20px',
                    padding: '2px 10px',
                    color: '#135c34',
                    fontSize: '12px',
                    fontWeight: '500'
                  }}>
                    Always enabled
                  </div>
                </InlineStack>
                <Text tone="subdued">
                  Partners share a unique referral link to promote your products. When customers buy through that link, the sale is attributed to the partner.
                </Text>
              </BlockStack>
            </div>
            
            {/* Card 2 */}
            <div 
              onClick={() => setCouponTrackingEnabled(!couponTrackingEnabled)}
              style={couponTrackingEnabled ? selectedCardStyle : unselectedCardStyle}
            >
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <InlineStack gap="200" blockAlign="center">
                    <div style={{ display: 'flex', color: couponTrackingEnabled ? BRAND_COLOR : 'var(--p-color-icon)' }}>
                      <Icon source={DiscountIcon} tone="base" />
                    </div>
                    <Text variant="headingSm" as="h3">Coupon tracking</Text>
                  </InlineStack>
                  
                  <div style={{
                    width: '20px', height: '20px', borderRadius: '4px', 
                    border: couponTrackingEnabled ? `1px solid ${RADIO_BLUE}` : '1px solid #8c9196',
                    background: couponTrackingEnabled ? RADIO_BLUE : 'transparent',
                    transition: 'all 0.2s ease',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center'
                  }}>
                    {couponTrackingEnabled && (
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M4.5 8.5L2 6L2.7 5.3L4.5 7.1L9.3 2.3L10 3L4.5 8.5Z" fill="white"/>
                      </svg>
                    )}
                  </div>
                </InlineStack>
                <Text tone="subdued">
                  Partners share a unique coupon code that tracks sales at checkout, even when customers do not click a referral link first.
                </Text>
              </BlockStack>
            </div>
          </InlineGrid>

          <Box paddingBlockStart="400">
            <InlineStack align="space-between">
              <Button onClick={handleBack}>Back</Button>
              <InlineStack gap="300">
                <Button variant="tertiary" onClick={handleFinish}>Skip</Button>
                <Button variant="primary" onClick={handleFinish}>Finish</Button>
              </InlineStack>
            </InlineStack>
          </Box>
        </BlockStack>
      )}
    </Page>
  );
}
