export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const tag   = req.body?.tag   || req.query?.hashtag;
  const limit = req.body?.limit || req.query?.limit || 30;

  if (!tag) { res.status(400).json({ error: '해시태그 검색어가 없습니다.' }); return; }

  const token = process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN;
  if (!token) { res.status(500).json({ error: 'Vercel에 API 토큰이 설정되지 않았습니다.' }); return; }

  try {
    // instagram-hashtag-scraper: 실제 이미지·계정 데이터 정상 반환 확인된 액터
    const apifyRes = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-hashtag-scraper/run-sync-get-dataset-items?token=${token}&timeout=120&memory=256`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hashtags: [tag],
          resultsLimit: parseInt(limit) || 30,
          _rid: Date.now()
        })
      }
    );
    const data = await apifyRes.json();
    res.status(200).json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(500).json([]);
  }
}
