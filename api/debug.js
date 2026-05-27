/**
 * GET /api/debug
 * Shows raw Locally API response — no auth needed for debugging
 */

const LOCALLY_API_URL   = process.env.LOCALLY_API_URL;
const LOCALLY_API_TOKEN = process.env.LOCALLY_API_TOKEN;

export default async function handler(req, res) {
  const baseUrl = LOCALLY_API_URL.replace(/\/\d+$/, "");
  const headers = {
    Accept: "application/json",
    ...(LOCALLY_API_TOKEN ? { "Locally-Api-Token": LOCALLY_API_TOKEN } : {}),
  };

  const r    = await fetch(`${baseUrl}/0`, { headers });
  const data = await r.json();
  const sample = (data.content ?? []).slice(0, 2);

  return res.status(200).json({
    http_status:         r.status,
    top_level_keys:      Object.keys(data),
    properties:          data.properties,
    total_page0:         (data.content ?? []).length,
    sample:              sample,
  });
}