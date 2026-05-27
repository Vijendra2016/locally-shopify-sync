/**
 * GET /api/health
 * Returns which env variables are configured (boolean only — never exposes values)
 */
export default function handler(req, res) {
  res.status(200).json({
    status:               "ok",
    locally_api_url:      !!process.env.LOCALLY_API_URL,
    locally_api_token:    !!process.env.LOCALLY_API_TOKEN,
    shopify_store:        !!process.env.SHOPIFY_STORE,
    shopify_client_id:    !!process.env.SHOPIFY_CLIENT_ID,
    shopify_client_secret:!!process.env.SHOPIFY_CLIENT_SECRET,
    sync_secret:          !!process.env.SYNC_SECRET,
  });
}
