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

const TAG_CLAIMED  = "Locally - Claimed";
const TAG_INV_LIVE = "Locally - Inv. Live";
const TAG_ROPIS    = "Ropis - Enabled";
const TAG_BOPIS    = "Bopis - Enabled";
const LOCALLY_TAGS = [TAG_CLAIMED, TAG_INV_LIVE, TAG_ROPIS, TAG_BOPIS];

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

  const pagePromises = [];
  for (let p = 1; p < totalPages; p++) {
    pagePromises.push(fetch(`${baseUrl}/${p}`, { headers }).then(r => r.json()));
  }
  const pages = await Promise.all(pagePromises);
  for (const page of pages) dealers.push(...(page.content ?? []));

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
        edges {
          node {
            id
            name
            contacts(first: 20) {
              edges {
                node {
                  isMainContact
                  customer { id tags email firstName lastName }
                }
              }
            }
          }
        }
      }
    }`,
    { q: `name:${name}` }
  );

  const match = (data?.companies?.edges ?? [])
    .find(e => e.node.name.toLowerCase() === name.toLowerCase());

  if (!match) return null;

  const node     = match.node;
  const contacts = node.contacts?.edges ?? [];
  const primary  = contacts.find(c => c.node.isMainContact) ?? contacts[0];

  return {
    id:       node.id,
    name:     node.name,
    customer: primary?.node?.customer ?? null,
  };
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

function computeTags(existingTags, claimed, invLive, ropis, bopis) {
  const preserved = (existingTags ?? []).filter(t => !LOCALLY_TAGS.includes(t));
  if (claimed)  preserved.push(TAG_CLAIMED);
  if (invLive)  preserved.push(TAG_INV_LIVE);
  if (ropis)    preserved.push(TAG_ROPIS);
  if (bopis)    preserved.push(TAG_BOPIS);
  return [...new Set(preserved)].sort();
}

async function updateCustomerTags(token, customerId, newTags) {
  await shopifyGQL(token,
    `mutation($id: ID!, $tags: [String!]!) {
      customerUpdate(input: { id: $id, tags: $tags }) {
        userErrors { field message }
      }
    }`,
    { id: customerId, tags: newTags }
  );
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (SYNC_SECRET && req.headers["x-sync-secret"] !== SYNC_SECRET)
    return res.status(401).json({ error: "Unauthorized" });

  const { company_name } = req.body ?? {};
  if (!company_name) return res.status(400).json({ error: "Missing company_name" });

  try {
    const shopifyToken = await getShopifyToken();

    // Find dealer in Locally
    const dealers = await fetchAllDealers();
    const dealer = dealers.find(
      d => (d.store_name ?? "").toLowerCase() === company_name.toLowerCase()
    );
    if (!dealer) return res.status(200).json({ status: "not_found_in_locally", company_name });

    // Same field names as sync-all.js
    const claimed = dealer.authorized === "true";
    const invLive = parseInt(dealer.count_of_brand_upcs_in_stock ?? "0", 10) > 0;
    const ropis   = dealer.ropis === "1";
    const bopis   = dealer.bopis === "1";

    // Find Shopify company + main contact
    const company = await findCompanyByName(shopifyToken, company_name);
    if (!company) return res.status(200).json({ status: "not_found_in_shopify", company_name });

    // Update metafields
    const metafields = await setMetafields(shopifyToken, company.id, claimed, invLive);

    // Update customer tags (add or remove based on current status)
    let customer_tags_updated = false;
    if (company.customer) {
      const newTags = computeTags(company.customer.tags, claimed, invLive, ropis, bopis);
      await updateCustomerTags(shopifyToken, company.customer.id, newTags);
      customer_tags_updated = true;
    }

    return res.status(200).json({
      status:                "updated",
      company_name,
      locally_claimed:       claimed,
      locally_inv_live:      invLive,
      customer_tags_updated,
      metafields,
    });

  } catch (err) {
    console.error("sync-dealer error:", err);
    return res.status(500).json({ error: err.message });
  }
}
