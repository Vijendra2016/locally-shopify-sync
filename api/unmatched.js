/**
 * GET /api/unmatched
 * Shows matched and unmatched dealers between Locally and Shopify.
 * Protected by CRON_SECRET (same as sync-all).
 */

import { getShopifyToken } from "./shopify-auth.js";

const LOCALLY_API_URL   = process.env.LOCALLY_API_URL;
const LOCALLY_API_TOKEN = process.env.LOCALLY_API_TOKEN;
const SHOPIFY_STORE     = process.env.SHOPIFY_STORE;
const CRON_SECRET       = process.env.CRON_SECRET;
const API_VER           = "2025-01";

async function fetchAllDealers() {
  const baseUrl = LOCALLY_API_URL.replace(/\/\d+$/, "");
  const headers = {
    Accept: "application/json",
    ...(LOCALLY_API_TOKEN ? { "Locally-Api-Token": LOCALLY_API_TOKEN } : {}),
  };

  const first      = await fetch(`${baseUrl}/0`, { headers }).then(r => r.json());
  const totalPages = first.properties?.total_pages ?? 1;
  const dealers    = [...(first.content ?? [])];

  const pagePromises = [];
  for (let p = 1; p < totalPages; p++) {
    pagePromises.push(fetch(`${baseUrl}/${p}`, { headers }).then(r => r.json()));
  }
  const pages = await Promise.all(pagePromises);
  for (const page of pages) dealers.push(...(page.content ?? []));

  return dealers;
}

async function fetchAllShopifyCompanies(token) {
  const companies = [];
  let cursor  = null;
  let hasNext = true;

  while (hasNext) {
    const variables = cursor ? { first: 100, after: cursor } : { first: 100 };
    const data = await shopifyGQL(token,
      `query($first: Int!, $after: String) {
        companies(first: $first, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node { id name } }
        }
      }`,
      variables
    );

    const edges = data?.companies?.edges ?? [];
    for (const edge of edges) companies.push({ id: edge.node.id, name: edge.node.name });

    hasNext = data?.companies?.pageInfo?.hasNextPage ?? false;
    cursor  = data?.companies?.pageInfo?.endCursor ?? null;
  }

  return companies;
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

/**
 * Simple fuzzy score: normalize both names and compute how similar they are.
 * Returns 0–100. Exact normalized match = 100.
 */
function normalize(name) {
  return name
    .toLowerCase()
    .replace(/[''`]/g, "")       // remove apostrophes
    .replace(/[.\-,]/g, " ")     // dashes/dots/commas → space
    .replace(/\s+/g, " ")        // collapse spaces
    .trim();
}

function fuzzyScore(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (na === nb) return 100;

  // Jaccard similarity on word sets
  const setA = new Set(na.split(" "));
  const setB = new Set(nb.split(" "));
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return Math.round((intersection / union) * 100);
}

export default async function handler(req, res) {
  const auth = req.headers.authorization;
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const shopifyToken = await getShopifyToken();

    const [dealers, shopifyCompanies] = await Promise.all([
      fetchAllDealers(),
      fetchAllShopifyCompanies(shopifyToken),
    ]);

    // Build exact map (lowercase)
    const exactMap = new Map();
    for (const c of shopifyCompanies) exactMap.set(c.name.toLowerCase().trim(), c.name);

    // Build normalized map for fuzzy suggestions
    const normalizedMap = new Map();
    for (const c of shopifyCompanies) normalizedMap.set(normalize(c.name), c.name);

    const matched   = [];
    const unmatched = [];

    for (const dealer of dealers) {
      const locallyName = (dealer.store_name ?? "").trim();
      if (!locallyName) continue;

      const exactHit = exactMap.get(locallyName.toLowerCase());
      if (exactHit) {
        matched.push({ locally: locallyName, shopify: exactHit });
        continue;
      }

      // Try normalized match
      const normHit = normalizedMap.get(normalize(locallyName));
      if (normHit) {
        matched.push({ locally: locallyName, shopify: normHit, via: "normalized" });
        continue;
      }

      // Find best fuzzy suggestion from Shopify companies
      let bestScore = 0;
      let bestMatch = null;
      for (const c of shopifyCompanies) {
        const score = fuzzyScore(locallyName, c.name);
        if (score > bestScore) { bestScore = score; bestMatch = c.name; }
      }

      unmatched.push({
        locally:         locallyName,
        best_shopify_match: bestScore >= 50 ? bestMatch : null,
        score:           bestScore >= 50 ? bestScore : null,
      });
    }

    // Sort unmatched by score descending (closest matches first)
    unmatched.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    return res.status(200).json({
      summary: {
        locally_dealers:    dealers.length,
        shopify_companies:  shopifyCompanies.length,
        matched:            matched.length,
        unmatched:          unmatched.length,
      },
      matched,
      unmatched,
    });

  } catch (err) {
    console.error("unmatched error:", err);
    return res.status(500).json({ error: err.message });
  }
}
