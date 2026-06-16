/**
 * /api/analyze-outfit.js — OzKiz Casting CRM
 * Google Gemini Vision으로 착장(옷) 이미지를 분석해 컨셉 추천 데이터 추출
 *
 * 필수 Vercel 환경변수:
 *   GEMINI_API_KEY   — Google Gemini API 키
 *
 * POST { image: { base64: string, mimeType: string } }
 * → { success: true, analysis: { targetGender, targetSize, styleTags, conceptSuggestion } }
 *
 * 모델: gemini-2.0-flash (실제 존재하는 가장 빠른 Gemini 멀티모달 모델)
 */

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')   { return res.status(405).json({ error: 'Method not allowed' }); }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({ error: '환경변수 GEMINI_API_KEY 가 설정되지 않았습니다.' });
  }

  const { image } = req.body || {};
  if (!image?.base64 || !image?.mimeType) {
    return res.status(400).json({ error: 'image.base64 와 image.mimeType 이 필요합니다.' });
  }

  const prompt = `이 아동복 착장 사진을 분석해서 캐스팅 컨셉 추천에 필요한 정보를 순수 JSON 형식으로만 반환해 줘. 마크다운 코드 블록 없이 { } JSON만 응답해.

필요한 필드:
- targetGender: "여아" 또는 "남아" (착장 스타일 기반 추정)
- targetSize: 숫자 (착장에 어울리는 아동 키, 예: 100, 110, 120, 130, 140)
- styleTags: 배열 — ["러블리", "캐주얼", "스트릿", "모던", "내추럴", "시크", "스포티", "클래식"] 중 해당하는 것들 (최대 3개)
- conceptSuggestion: 이 착장으로 찍을 수 있는 컨셉 촬영 아이디어 1~2문장 (한국어)`;

  try {
    // Gemini REST API (generateContent endpoint)
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: image.mimeType,
                  data:     image.base64,
                },
              },
            ],
          }],
          generationConfig: {
            temperature:     0.2,
            maxOutputTokens: 500,
          },
        }),
        signal: AbortSignal.timeout(50_000),
      }
    );

    if (!geminiRes.ok) {
      const errBody = await geminiRes.json().catch(() => ({}));
      throw new Error(errBody.error?.message || `Gemini HTTP ${geminiRes.status}`);
    }

    const data    = await geminiRes.json();
    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    // JSON 추출 (마크다운 래핑 방어)
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    let analysis = {};
    if (jsonMatch) {
      try { analysis = JSON.parse(jsonMatch[0]); } catch { analysis = {}; }
    }

    // 기본값 보정
    analysis.targetGender     = analysis.targetGender     || '여아';
    analysis.targetSize       = parseInt(analysis.targetSize) || 110;
    analysis.styleTags        = Array.isArray(analysis.styleTags) ? analysis.styleTags.slice(0, 5) : [];
    analysis.conceptSuggestion = analysis.conceptSuggestion || '';

    return res.status(200).json({ success: true, analysis });

  } catch (e) {
    console.error('[analyze-outfit]', e.message);
    return res.status(500).json({ error: `AI 분석 실패: ${e.message}` });
  }
}
