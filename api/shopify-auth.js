/**
 * Gets a short-lived Shopify Admin API access token
 * using Client Credentials grant (new method as of Jan 2026)
 * Token lasts 24 hours — fetched fresh on each function call
 */

const SHOPIFY_STORE         = process.env.SHOPIFY_STORE;
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

export async function getShopifyToken() {
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
