/**
 * POST /api/sync-dealer
 * Called by Shopify Flow when a Company is created/updated.
 * Body: { "company_name": "951 Bikes" }
 * Header: X-Sync-Secret: <your SYNC_SECRET>
 */

import { getShopifyToken } from "./shopify-auth.js";

const LOCALLY_API_URL   = process.env.LOCALLY_API_URL;
const LOCALLY_API_TOKEN = process.env.LOCALLY_API_TOKEN;
const SHOPIFY_STORE     = process.env.SHOPIFY_STORE;
const SYNC_SECRET       = process.env.SYNC_SECRET;
const API_VER           = "2025-01";

// ─── Locally ─────────────────────────────────────────────────────────────────

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
  }
  return dealers;
}

// ─── Shopify GraphQL ──────────────────────────────────────────────────────────

async function shopifyGQL(token, query, variables = {}) {
  const res = await fetch(
    `https://${SHOPIFY_STORE}/admin/api/${API_VER}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
    }
  );
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function findCompanyByName(token, name) {
  const data = await shopifyGQL(token,
    `query($q: String!) {
      companies(first: 5, query: $q) {
        edges { node { id name } }
      }
    }`,
    { q: `name:${name}` }
  );
  const match = (data?.companies?.edges ?? [])
    .find(e => e.node.name.toLowerCase() === name.toLowerCase());
  return match?.node ?? null;
}

async function setMetafields(token, companyId, claimed, invLive) {
  const data = await shopifyGQL(token,
    `mutation($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields { key value }
        userErrors  { field message }
      }
    }`,
    {
      metafields: [
        { ownerId: companyId, namespace: "custom", key: "locally_claimed",  type: "boolean", value: claimed  ? "true" : "false" },
        { ownerId: companyId, namespace: "custom", key: "locally_inv_live", type: "boolean", value: invLive  ? "true" : "false" },
      ],
    }
  );
  const errors = data?.metafieldsSet?.userErrors ?? [];
  if (errors.length) throw new Error(JSON.stringify(errors));
  return data?.metafieldsSet?.metafields;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (SYNC_SECRET && req.headers["x-sync-secret"] !== SYNC_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const { company_name } = req.body ?? {};
  if (!company_name) return res.status(400).json({ error: "Missing company_name" });

  try {
    // 1. Get Shopify token automatically
    const shopifyToken = await getShopifyToken();

    // 2. Find dealer in Locally
    const dealers = await fetchAllDealers();
    const dealer = dealers.find(
      d => (d.store_name ?? "").toLowerCase() === company_name.toLowerCase()
    );
    if (!dealer) return res.status(200).json({ status: "not_found_in_locally", company_name });

    // 3. Check flags
    const claimed = (dealer.store_company_claimed ?? "").toLowerCase() === "claimed";
    const invLive = (dealer.store_inventory_status ?? "").toLowerCase() === "live";

    // 4. Find Shopify company
    const company = await findCompanyByName(shopifyToken, company_name);
    if (!company) return res.status(200).json({ status: "not_found_in_shopify", company_name });

    // 5. Write metafields
    const metafields = await setMetafields(shopifyToken, company.id, claimed, invLive);

    return res.status(200).json({
      status: "updated", company_name,
      locally_claimed: claimed, locally_inv_live: invLive,
      metafields,
    });

  } catch (err) {
    console.error("sync-dealer error:", err);
    return res.status(500).json({ error: err.message });
  }
}
