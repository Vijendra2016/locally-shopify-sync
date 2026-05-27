const LOCALLY_API_URL   = process.env.LOCALLY_API_URL;
const LOCALLY_API_TOKEN = process.env.LOCALLY_API_TOKEN;

export default async function handler(req, res) {
  const baseUrl = LOCALLY_API_URL.replace(/\/\d+$/, "");

  // Try 3 different auth methods
  const methods = [
    { name: "Locally-Api-Token header", headers: { "Accept": "application/json", "Locally-Api-Token": LOCALLY_API_TOKEN } },
    { name: "Authorization Bearer",     headers: { "Accept": "application/json", "Authorization": `Bearer ${LOCALLY_API_TOKEN}` } },
    { name: "api_token query param",    url: `${baseUrl}/0?api_token=${LOCALLY_API_TOKEN}`, headers: { "Accept": "application/json" } },
  ];

  const results = [];
  for (const m of methods) {
    const url = m.url ?? `${baseUrl}/0`;
    const r   = await fetch(url, { headers: m.headers });
    const d   = await r.json();
    results.push({
      method:   m.name,
      status:   r.status,
      keys:     Object.keys(d),
      message:  d.message ?? null,
      has_content: !!d.content,
      dealers:  (d.content ?? []).length,
    });
  }

  return res.status(200).json({ token_prefix: LOCALLY_API_TOKEN?.slice(0,8) + "...", results });
}