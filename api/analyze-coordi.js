/**
 * /api/analyze-coordi.js — OzKiz Casting CRM
 * GPT-4o Vision으로 코디 이미지를 분석해 캐스팅 데이터를 추출
 *
 * 필수 Vercel 환경변수:
 *   OPENAI_API_KEY   — OpenAI API 시크릿 키 (sk-...)
 *
 * POST { imageUrls: string[] }
 * → { success: true, analysis: { predictedGender, predictedSize, styleTags, dominantColors, moodKeywords } }
 */

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')   { return res.status(405).json({ error: 'Method not allowed' }); }

  const OPENAI_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_KEY) {
    return res.status(500).json({ error: '환경변수 OPENAI_API_KEY 가 설정되지 않았습니다.' });
  }

  const { imageUrls } = req.body || {};
  if (!Array.isArray(imageUrls) || !imageUrls.length) {
    return res.status(400).json({ error: '이미지 URL 배열이 필요합니다.' });
  }

  // 최대 5장만 분석 (비용·속도 최적화)
  const targets = imageUrls.slice(0, 5);

  const imageContent = targets.map(url => ({
    type: 'image_url',
    image_url: { url, detail: 'low' },
  }));

  const prompt = `다음 아동복 코디 사진들을 분석하여, 캐스팅에 필요한 핵심 정보를 순수 JSON 형식으로만 반환해 줘. 마크다운 코드 블록 없이 { } JSON만 응답해.

필요한 필드:
- predictedGender: "여아" 또는 "남아" (코디 스타일 기반 추정)
- predictedSize: 숫자 (아동복 사이즈 기준, 예: 100, 110, 120, 130, 140)
- styleTags: 배열 — ["러블리", "캐주얼", "스트릿", "모던", "내추럴", "시크", "스포티", "클래식"] 중 해당하는 것들
- dominantColors: 주요 색상 배열 (한국어, 예: ["화이트", "베이지", "핑크", "네이비"])
- moodKeywords: 전반적 무드 키워드 배열 (예: ["밝은", "화사한", "차분한", "활동적인"])`;

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:      'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            ...imageContent,
          ],
        }],
        max_tokens:  600,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(50_000),
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `OpenAI HTTP ${openaiRes.status}`);
    }

    const data    = await openaiRes.json();
    const rawText = data.choices?.[0]?.message?.content || '{}';

    // JSON 추출 (마크다운 래핑 방어)
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    let analysis = {};
    if (jsonMatch) {
      try { analysis = JSON.parse(jsonMatch[0]); } catch { analysis = {}; }
    }

    // 기본값 보정
    analysis.predictedGender = analysis.predictedGender || '여아';
    analysis.predictedSize   = parseInt(analysis.predictedSize) || 110;
    analysis.styleTags       = Array.isArray(analysis.styleTags)     ? analysis.styleTags     : [];
    analysis.dominantColors  = Array.isArray(analysis.dominantColors)? analysis.dominantColors: [];
    analysis.moodKeywords    = Array.isArray(analysis.moodKeywords)  ? analysis.moodKeywords  : [];

    return res.status(200).json({ success: true, analysis });

  } catch (e) {
    console.error('[analyze-coordi]', e.message);
    return res.status(500).json({ error: `AI 분석 실패: ${e.message}` });
  }
}
