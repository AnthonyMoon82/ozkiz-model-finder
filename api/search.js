export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const { tag, limit } = req.body || {};
  if (!tag) { res.status(400).json({ error: 'tag required' }); return; }

  const token = process.env.APIFY_TOKEN;
  if (!token) { res.status(500).json({ error: 'APIFY_TOKEN not set' }); return; }

  try {
    const apifyRes = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper/run-sync-get-dataset-items?token=${token}&timeout=120&memory=256`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hashtags: [tag], resultsLimit: parseInt(limit) || 30, _rid: Date.now() })
      }
    );
    const data = await apifyRes.json();
    res.status(200).json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(500).json([]);
  }
}
