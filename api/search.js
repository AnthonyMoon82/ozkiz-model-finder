export default async function handler(req, res) {
  // CORS 설정
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // 클로드의 POST 방식과 이전 GET 방식 모두 지원
  const tag = req.body?.tag || req.query?.hashtag;
  const limit = req.body?.limit || req.query?.limit || 30;

  if (!tag) { res.status(400).json({ error: '해시태그 검색어가 없습니다.' }); return; }

  // Vercel 설정에 등록한 변수명 찾기 (둘 중 하나라도 있으면 작동)
  const token = process.env.APIFY_API_TOKEN || process.env.APIFY_TOKEN;

  if (!token) { res.status(500).json({ error: 'Vercel에 API 토큰이 설정되지 않았습니다.' }); return; }

  try {
    // 크레딧 소모가 적고 안전한 기본 instagram-scraper 액터 사용
    const apifyRes = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?token=${token}&timeout=120&memory=256`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          search: tag,
          searchType: 'hashtag',
          searchLimit: 1,
          resultsLimit: parseInt(limit) || 30
        })
      }
    );
    
    const data = await apifyRes.json();
    res.status(200).json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(500).json([]);
  }
}
