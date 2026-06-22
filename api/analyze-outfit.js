/**
 * /api/analyze-outfit.js — OzKiz Casting CRM
 * Google Gemini Vision으로 착장(코디 묶음) 이미지를 종합 분석해 컨셉 추천 데이터 추출
 *
 * 필수 Vercel 환경변수:
 *   GEMINI_API_KEY   — Google Gemini API 키
 *
 * POST { images: [{ base64: string, mimeType: string }, ...] }  ← 다중 이미지 배열
 * → { success: true,  analysis: { targetGender, targetSize, styleTags, conceptSuggestion } }
 * → { success: false, error: "친절한 한국어 에러 메시지" }
 *
 * 모델: gemini-2.5-pro (최고 성능 Pro 모델, 다중 이미지 종합 분석)
 */

export const maxDuration = 60;           // Vercel Fluid 컴퓨팅 (신규 방식)
export const config     = { maxDuration: 60 }; // Vercel 레거시 호환

// ── Gemini HTTP 에러 코드 → 친절한 한국어 메시지 변환 ──────────
function toKoreanError(status, rawMessage = '') {
  const msg = rawMessage.toLowerCase();

  if (msg.includes('high demand') || msg.includes('overloaded') ||
      status === 503 || status === 429) {
    return '현재 AI 서버에 사용자가 몰려 지연되고 있습니다. 잠시 후 다시 시도해 주세요.';
  }
  if (msg.includes('quota') || msg.includes('rate limit')) {
    return 'AI 분석 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.';
  }
  if (msg.includes('timeout') || msg.includes('timed out') ||
      msg.includes('aborted') || status === 504) {
    return 'AI 분석 요청 시간이 초과됐습니다. 이미지 수를 줄이거나 잠시 후 다시 시도해 주세요.';
  }
  if (msg.includes('invalid api key') || msg.includes('api_key') || status === 401 || status === 403) {
    return 'Gemini API 키가 유효하지 않습니다. Vercel 환경변수(GEMINI_API_KEY)를 확인해 주세요.';
  }
  if (msg.includes('image') || msg.includes('media') || status === 400) {
    return '이미지 형식을 처리할 수 없습니다. JPG 또는 PNG 파일을 사용해 주세요.';
  }
  if (status >= 500) {
    return 'Google AI 서버에 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
  }
  return 'AI 분석 중 알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')   { return res.status(405).json({ success: false, error: 'Method not allowed' }); }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return res.status(500).json({
      success: false,
      error: '서버 설정 오류: GEMINI_API_KEY 환경변수가 없습니다. 관리자에게 문의해 주세요.',
    });
  }

  const { images } = req.body || {};
  if (!Array.isArray(images) || !images.length) {
    return res.status(400).json({ success: false, error: '이미지 데이터가 없습니다.' });
  }

  // 최대 5장만 처리 (과부하 방지)
  const targets = images.slice(0, 5).filter(img => img?.base64 && img?.mimeType);
  if (!targets.length) {
    return res.status(400).json({ success: false, error: '유효한 이미지 데이터가 없습니다.' });
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

  // ── Gemini API 호출 ────────────────────────────────────────
  let geminiRes;
  try {
    geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${GEMINI_KEY}`,
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
  } catch (fetchErr) {
    // 네트워크 오류 / 타임아웃
    console.error('[analyze-outfit] fetch 실패:', fetchErr.message);
    const isTimeout = fetchErr.name === 'TimeoutError' || fetchErr.message.includes('abort');
    return res.status(503).json({
      success: false,
      error: isTimeout
        ? 'AI 분석 요청 시간이 초과됐습니다. 이미지 수를 줄이거나 잠시 후 다시 시도해 주세요.'
        : '네트워크 오류로 AI 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }

  // ── HTTP 상태 에러 처리 ────────────────────────────────────
  if (!geminiRes.ok) {
    let errMessage = '';
    try {
      const errBody = await geminiRes.json();
      errMessage = errBody.error?.message || '';
    } catch { /* JSON 파싱 실패 시 무시 */ }

    const koreanMsg = toKoreanError(geminiRes.status, errMessage);
    console.error(`[analyze-outfit] Gemini HTTP ${geminiRes.status}: ${errMessage}`);
    return res.status(502).json({ success: false, error: koreanMsg });
  }

  // ── 응답 파싱 ──────────────────────────────────────────────
  let data;
  try {
    data = await geminiRes.json();
  } catch (parseErr) {
    console.error('[analyze-outfit] 응답 JSON 파싱 실패:', parseErr.message);
    return res.status(502).json({
      success: false,
      error: 'AI 서버 응답을 처리하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }

  // ── 후보 텍스트 추출 ──────────────────────────────────────
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!rawText) {
    console.warn('[analyze-outfit] Gemini 빈 응답:', JSON.stringify(data).slice(0, 200));
    return res.status(502).json({
      success: false,
      error: 'AI가 분석 결과를 반환하지 않았습니다. 다시 시도해 주세요.',
    });
  }

  // ── JSON 추출 (마크다운 래핑 방어) ────────────────────────
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  let analysis = {};
  if (jsonMatch) {
    try { analysis = JSON.parse(jsonMatch[0]); } catch { analysis = {}; }
  }

  // ── 기본값 보정 ────────────────────────────────────────────
  analysis.targetGender      = analysis.targetGender      || '여아';
  analysis.targetSize        = parseInt(analysis.targetSize) || 110;
  analysis.styleTags         = Array.isArray(analysis.styleTags) ? analysis.styleTags.slice(0, 5) : [];
  analysis.conceptSuggestion = analysis.conceptSuggestion  || '';

  return res.status(200).json({ success: true, analysis });
}
