/**
 * GET /api/sync-all
 * Fast sync — fetches ALL Shopify companies upfront into memory,
 * then matches against Locally dealers instantly without extra API calls.
 *
 * Flow:
 * 1. Fetch all Locally dealers (10 pages = ~10 calls)
 * 2. Fetch all Shopify companies (paginated = ~10-20 calls)
 * 3. Build name→company map in memory
 * 4. Loop dealers → instant map lookup → only call Shopify to UPDATE
 *
 * Result: ~30-40 seconds total ✅ fits Vercel Hobby 60s limit
 */

import { getShopifyToken } from "./shopify-auth.js";

const LOCALLY_API_URL   = process.env.LOCALLY_API_URL;
const LOCALLY_API_TOKEN = process.env.LOCALLY_API_TOKEN;
const SHOPIFY_STORE     = process.env.SHOPIFY_STORE;
const CRON_SECRET       = process.env.CRON_SECRET;
const API_VER           = "2025-01";

const TAG_CLAIMED  = "Locally - Claimed";
const TAG_INV_LIVE = "Locally - Inv. Live";
const LOCALLY_TAGS = [TAG_CLAIMED, TAG_INV_LIVE];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Step 1: Fetch ALL dealers from Locally ───────────────────────────────────

async function fetchAllDealers() {
  const baseUrl = LOCALLY_API_URL.replace(/\/\d+$/, "");
  const headers = {
    Accept: "application/json",
    ...(LOCALLY_API_TOKEN ? { "Locally-Api-Token": LOCALLY_API_TOKEN } : {}),
  };

  const first      = await fetch(`${baseUrl}/0`, { headers }).then(r => r.json());
  const totalPages = first.properties?.total_pages ?? 1;
  const dealers    = [...(first.content ?? [])];

  // Fetch all pages in parallel for speed
  const pagePromises = [];
  for (let p = 1; p < totalPages; p++) {
    pagePromises.push(
      fetch(`${baseUrl}/${p}`, { headers }).then(r => r.json())
    );
  }
  const pages = await Promise.all(pagePromises);
  for (const page of pages) {
    dealers.push(...(page.content ?? []));
  }

  return dealers;
}

// ─── Step 2: Fetch ALL Shopify companies into memory ─────────────────────────

async function fetchAllShopifyCompanies(token) {
  const companies = [];
  let cursor      = null;
  let hasNext     = true;

  while (hasNext) {
    const variables = cursor
      ? { first: 100, after: cursor }
      : { first: 100 };

    const data = await shopifyGQL(token,
      `query($first: Int!, $after: String) {
        companies(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
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
      variables
    );

    const edges = data?.companies?.edges ?? [];
    for (const edge of edges) {
      const node     = edge.node;
      const contacts = node.contacts?.edges ?? [];
      const primary  = contacts.find(c => c.node.isMainContact) ?? contacts[0];

      companies.push({
        id:       node.id,
        name:     node.name,
        customer: primary?.node?.customer ?? null,
      });
    }

    hasNext = data?.companies?.pageInfo?.hasNextPage ?? false;
    cursor  = data?.companies?.pageInfo?.endCursor ?? null;
  }

  return companies;
}

/**
 * Build a fast name→company lookup map
 * Key: lowercase company name
 * Value: { id, customer }
 */
function buildCompanyMap(companies) {
  const map = new Map();
  for (const company of companies) {
    map.set(company.name.toLowerCase().trim(), company);
  }
  return map;
}

// ─── Shopify GraphQL ──────────────────────────────────────────────────────────

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

async function setCompanyMetafields(token, companyId, claimed, invLive) {
  await shopifyGQL(token,
    `mutation($m: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $m) { userErrors { field message } }
    }`,
    {
      m: [
        { ownerId: companyId, namespace: "custom", key: "locally_claimed",  type: "boolean", value: claimed  ? "true" : "false" },
        { ownerId: companyId, namespace: "custom", key: "locally_inv_live", type: "boolean", value: invLive  ? "true" : "false" },
      ],
    }
  );
}

function computeTags(existingTags, claimed, invLive) {
  const preserved = (existingTags ?? []).filter(t => !LOCALLY_TAGS.includes(t));
  if (claimed)  preserved.push(TAG_CLAIMED);
  if (invLive)  preserved.push(TAG_INV_LIVE);
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
  const auth = req.headers.authorization;
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`)
    return res.status(401).json({ error: "Unauthorized" });

  const stats = {
    locally_dealers:    0,
    shopify_companies:  0,
    companies_updated:  0,
    customers_updated:  0,
    not_found:          0,
    errors:             0,
  };

  const startTime = Date.now();

  try {
    const shopifyToken = await getShopifyToken();

    // Step 1 & 2 — fetch both lists IN PARALLEL for maximum speed
    console.log("Fetching Locally dealers and Shopify companies in parallel...");
    const [dealers, shopifyCompanies] = await Promise.all([
      fetchAllDealers(),
      fetchAllShopifyCompanies(shopifyToken),
    ]);

    stats.locally_dealers   = dealers.length;
    stats.shopify_companies = shopifyCompanies.length;

    console.log(`Locally: ${dealers.length} dealers | Shopify: ${shopifyCompanies.length} companies`);

    // Step 3 — build instant lookup map (no API calls)
    const companyMap = buildCompanyMap(shopifyCompanies);

    // Step 4 — loop dealers, instant map lookup, only call Shopify to UPDATE
    const updatePromises = [];

    for (const dealer of dealers) {
      const name = (dealer.store_name ?? "").trim();
      if (!name) { stats.not_found++; continue; }

      const company = companyMap.get(name.toLowerCase());
      if (!company) { stats.not_found++; continue; }

      const claimed = dealer.authorized === "true";
      const invLive = parseInt(dealer.count_of_brand_upcs_in_stock ?? "0", 10) > 0;

      // Queue updates — run in parallel batches of 10
      updatePromises.push(async () => {
        try {
          await setCompanyMetafields(shopifyToken, company.id, claimed, invLive);
          stats.companies_updated++;

          if (company.customer) {
            const newTags = computeTags(company.customer.tags, claimed, invLive);
            await updateCustomerTags(shopifyToken, company.customer.id, newTags);
            stats.customers_updated++;
          }
        } catch (err) {
          stats.errors++;
          console.error(`Error updating ${name}:`, err.message);
        }
      });
    }

    // Run updates in parallel batches of 10
    const BATCH = 10;
    for (let i = 0; i < updatePromises.length; i += BATCH) {
      const batch = updatePromises.slice(i, i + BATCH);
      await Promise.all(batch.map(fn => fn()));
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    return res.status(200).json({
      status:   "complete",
      duration: `${duration}s`,
      stats,
    });

  } catch (err) {
    console.error("Sync error:", err);
    return res.status(500).json({ error: err.message, stats });
  }
}
