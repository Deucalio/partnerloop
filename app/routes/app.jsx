import { Outlet, useLoaderData, useNavigation, useRouteError } from "react-router";
import { useEffect } from "react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { getAttentionItems } from "../services/attention.server";
import { AttentionCenter } from "../components/AttentionCenter";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  // Loaded in the layout so outstanding work follows the merchant around the
  // app rather than only appearing on the dashboard. Three cheap aggregates.
  const attention = await getAttentionItems(session.shop);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", attention };
};

import { AppProvider as PolarisAppProvider } from "@shopify/polaris";
import enTranslations from "@shopify/polaris/locales/en.json";

/**
 * Drives Shopify admin's own top loading bar from React Router's navigation
 * state, so every page transition and form submission gets feedback.
 *
 * Loaders here hit Postgres and the Admin API, so a click can sit for a second
 * with nothing happening — which reads as a broken button. `shopify` is the
 * global App Bridge installs; guarded because it is absent outside the admin.
 */
function NavigationProgress() {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  useEffect(() => {
    if (typeof shopify === "undefined" || typeof shopify?.loading !== "function") return;
    shopify.loading(busy);
    // Clear the bar if this unmounts mid-navigation, otherwise it sticks on.
    return () => shopify.loading(false);
  }, [busy]);

  return null;
}

export default function App() {
  const { apiKey, attention } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavigationProgress />
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/programs">Programs</s-link>
        <s-link href="/app/creators">Creators</s-link>
        <s-link href="/app/commissions">Commissions</s-link>
        <s-link href="/app/payouts">Payouts</s-link>
      </s-app-nav>
      <PolarisAppProvider i18n={enTranslations}>
        <Outlet />
        <AttentionCenter items={attention.items} signature={attention.signature} />
      </PolarisAppProvider>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
