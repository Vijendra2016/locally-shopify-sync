/**
 * GET /api/callback
 * Catches the OAuth callback from Shopify and exchanges the code for a token
 */



const SHOPIFY_STORE         = process.env.SHOPIFY_STORE;
const SHOPIFY_CLIENT_ID     = process.env.SHOPIFY_CLIENT_ID;
const SHOPIFY_CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

export default async function handler(req, res) {
  const { code } = req.query;

  if (!code) {
    return res.status(400).json({ error: "No code provided" });
  }

  try {
    const response = await fetch(
      `https://${SHOPIFY_STORE}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id:     SHOPIFY_CLIENT_ID,
          client_secret: SHOPIFY_CLIENT_SECRET,
          code,
        }),
      }
    );

    const data = await response.json();

    // Show the token on screen so you can copy it
    return res.status(200).send(`
      <h2>✅ Success! Copy your access token:</h2>
      <p style="font-family:monospace; font-size:18px; background:#f0f0f0; padding:20px;">
        ${data.access_token}
      </p>
      <p>Add this to Vercel as <strong>SHOPIFY_ACCESS_TOKEN</strong></p>
      <p>Scope: ${data.scope}</p>
    `);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
