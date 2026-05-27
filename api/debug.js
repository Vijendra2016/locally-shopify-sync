/**
 * GET /api/debug
 * Shows raw Locally API response so we can see the exact data structure
 */

const LOCALLY_API_URL   = process.env.LOCALLY_API_URL;
const LOCALLY_API_TOKEN = process.env.LOCALLY_API_TOKEN;
const SYNC_SECRET       = process.env.SYNC_SECRET;

export default async function handler(req, res) {
  // Basic auth check
  if (SYNC_SECRET && req.headers["x-sync-secret"] !== SYNC_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const baseUrl = LOCALLY_API_URL.replace(/\/\d+$/, "");
  const headers = {
    Accept: "application/json",
    ...(LOCALLY_API_TOKEN ? { "Locally-Api-Token": LOCALLY_API_TOKEN } : {}),
  };

  // Fetch just page 0
  const res0 = await fetch(`${baseUrl}/0`, { headers });
  const data  = await res0.json();

  // Return the first 2 dealers so we can see field names
  const sample = (data.content ?? []).slice(0, 2);

  return res.status(200).json({
    http_status:  res0.status,
    top_level_keys: Object.keys(data),
    properties:   data.properties,
    total_dealers_page0: (data.content ?? []).length,
    sample_dealers: sample,
  });
}