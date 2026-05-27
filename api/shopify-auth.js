/**
 * Gets a Shopify Admin API access token using Authorization Code Grant
 * This works across organizations (partner app + client store)
 */

const SHOPIFY_STORE         = process.env.SHOPIFY_STORE;
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
const SHOPIFY_TOKEN         = process.env.SHOPIFY_ACCESS_TOKEN;

export async function getShopifyToken() {
  // If a direct token is provided, use it
  if (SHOPIFY_TOKEN) return SHOPIFY_TOKEN;

  // Otherwise try client credentials
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id:     SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
        grant_type:    "client_credentials",
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Shopify token exchange failed ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.access_token;
}
