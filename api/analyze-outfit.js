/**
 * /api/analyze-outfit.js — OzKiz Casting CRM
 * Google Gemini Vision으로 착장(코디 묶음) 이미지를 종합 분석해 컨셉 추천 데이터 추출
 *
 * 필수 Vercel 환경변수:
 *   GEMINI_API_KEY   — Google Gemini API 키
 *
 * POST { images: [{ base64: string, mimeType: string }, ...] }  ← 다중 이미지 배열
 * → { success: true, analysis: { targetGender, targetSize, styleTags, conceptSuggestion } }
 *
 * 모델: gemini-3.5-flash (다중 이미지 종합 분석에 최적화)
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

  const { images } = req.body || {};
  if (!Array.isArray(images) || !images.length) {
    return res.status(400).json({ error: 'images 배열이 필요합니다. (예: [{ base64, mimeType }, ...])' });
  }

  // 최대 5장만 처리 (과부하 방지)
  const targets = images.slice(0, 5).filter(img => img?.base64 && img?.mimeType);
  if (!targets.length) {
    return res.status(400).json({ error: '유효한 이미지 데이터가 없습니다.' });
  }

  const prompt = `다음은 이번 화보 촬영에 쓰일 여러 장의 아동복 착장(코디) 사진들 묶음이야. 이 사진들을 종합적으로 분석해서 전체적인 톤앤매너와 공통된 무드를 파악한 뒤, 다음 JSON 형식으로만 답해줘. 마크다운 코드 블록 없이 { } JSON만 응답해.

{
  "targetGender": "여아/남아/공용 중 하나",
  "targetSize": 110,
  "styleTags": ["태그1", "태그2", "태그3"],
  "conceptSuggestion": "이 착장 묶음에 어울리는 촬영 컨셉 제안 (1~2문장, 한국어)"
}

각 필드 기준:
- targetGender: 착장 스타일 기반 추정 ("여아", "남아", "공용")
- targetSize: 착장에 어울리는 아동 키 (숫자만, 예: 100, 110, 120, 130, 140)
- styleTags: 전체 착장의 공통 무드 키워드 배열 (["러블리", "캐주얼", "스트릿", "모던", "내추럴", "시크", "스포티", "클래식"] 중 최대 3개)
- conceptSuggestion: 이 코디 묶음으로 연출할 수 있는 촬영 컨셉 아이디어`;

  // parts 배열: 텍스트 프롬프트 + 모든 이미지 inlineData
  const parts = [
    { text: prompt },
    ...targets.map(img => ({
      inlineData: { mimeType: img.mimeType, data: img.base64 },
    })),
  ];

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature:     0.2,
            maxOutputTokens: 600,
          },
        }),
        signal: AbortSignal.timeout(55_000),
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
