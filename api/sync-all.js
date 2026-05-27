/**
 * GET /api/sync-all
 * Vercel Cron — nightly 2 AM UTC
 * Syncs ALL dealers from Locally to Shopify Company metafields
 */

import { getShopifyToken } from "./shopify-auth.js";

const LOCALLY_API_URL   = process.env.LOCALLY_API_URL;
const LOCALLY_API_TOKEN = process.env.LOCALLY_API_TOKEN;
const SHOPIFY_STORE     = process.env.SHOPIFY_STORE;
const CRON_SECRET       = process.env.CRON_SECRET;
const API_VER           = "2025-01";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAllDealers() {
  const baseUrl = LOCALLY_API_URL.replace(/\/\d+$/, "");
  const headers = {
    Accept: "application/json",
    ...(LOCALLY_API_TOKEN ? { "Locally-Api-Token": LOCALLY_API_TOKEN } : {}),
  };
  const first = await fetch(`${baseUrl}/0`, { headers }).then(r => r.json());
  const totalPages = first.properties?.total_pages ?? 1;
  const dealers = [...(first.content ?? [])];
  for (let p = 1; p < totalPages; p++) {
    const page = await fetch(`${baseUrl}/${p}`, { headers }).then(r => r.json());
    dealers.push(...(page.content ?? []));
    await sleep(200);
  }
  return dealers;
}

async function shopifyGQL(token, query, variables = {}) {
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${API_VER}/graphql.json`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    }
  );
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function findCompanyByName(token, name) {
  const data = await shopifyGQL(token,
    `query($q: String!) { companies(first: 5, query: $q) { edges { node { id name } } } }`,
    { q: `name:${name}` }
  );
  const match = (data?.companies?.edges ?? [])
    .find(e => e.node.name.toLowerCase() === name.toLowerCase());
  return match?.node ?? null;
}

async function setMetafields(token, companyId, claimed, invLive) {
  await shopifyGQL(token,
    `mutation($m: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $m) { userErrors { field message } } }`,
    {
      m: [
        { ownerId: companyId, namespace: "custom", key: "locally_claimed",  type: "boolean", value: claimed  ? "true" : "false" },
        { ownerId: companyId, namespace: "custom", key: "locally_inv_live", type: "boolean", value: invLive  ? "true" : "false" },
      ],
    }
  );
}

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`)
    return res.status(401).json({ error: "Unauthorized" });

  const stats = { total: 0, updated: 0, not_found: 0, errors: 0 };

  try {
    const shopifyToken = await getShopifyToken();
    const dealers = await fetchAllDealers();
    stats.total = dealers.length;

    for (const dealer of dealers) {
      const name = (dealer.store_name ?? "").trim();
      if (!name) { stats.not_found++; continue; }

      const claimed = (dealer.store_company_claimed ?? "").toLowerCase() === "claimed";
      const invLive = (dealer.store_inventory_status ?? "").toLowerCase() === "live";

      try {
        const company = await findCompanyByName(shopifyToken, name);
        if (!company) { stats.not_found++; continue; }
        await setMetafields(shopifyToken, company.id, claimed, invLive);
        stats.updated++;
      } catch (err) {
        stats.errors++;
        console.error(`Error syncing ${name}:`, err.message);
      }

      await sleep(300);
    }

    return res.status(200).json({ stats });
  } catch (err) {
    return res.status(500).json({ error: err.message, stats });
  }
}
