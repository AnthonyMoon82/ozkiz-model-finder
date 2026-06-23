/**
 * /api/analyze-outfit.js — OzKiz Casting CRM
 * Anthropic Claude Vision으로 착장(코디 묶음) 이미지를 종합 분석해 컨셉 추천 데이터 추출
 *
 * 필수 Vercel 환경변수:
 *   ANTHROPIC_API_KEY  — Anthropic 공식 API 마스터 키
 *
 * POST { images: [{ base64: string, mimeType: string }, ...] }  ← 다중 이미지 배열
 * → { success: true,  analysis: { targetGender, targetSize, styleTags, conceptSuggestion } }
 * → { success: false, error: "친절한 한국어 에러 메시지" }
 *
 * 모델: claude-haiku-4-5-20251001 (초고속 · Vercel 10초 타임아웃 대응)
 */

export const maxDuration = 60;           // Vercel Fluid 컴퓨팅 (신규 방식)
export const config     = { maxDuration: 60 }; // Vercel 레거시 호환

// ── Anthropic HTTP 에러 코드 → 친절한 한국어 메시지 변환 ─────────
function toKoreanError(status, rawMessage = '') {
  const msg = rawMessage.toLowerCase();

  if (status === 529 || msg.includes('overloaded') || msg.includes('high demand')) {
    return '현재 AI 서버에 사용자가 몰려 지연되고 있습니다. 잠시 후 다시 시도해 주세요.';
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
    return 'AI 분석 요청 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.';
  }
  if (msg.includes('timeout') || msg.includes('timed out') ||
      msg.includes('aborted') || status === 504) {
    return 'AI 분석 요청 시간이 초과됐습니다. 이미지 수를 줄이거나 잠시 후 다시 시도해 주세요.';
  }
  if (status === 401 || status === 403 || msg.includes('invalid') || msg.includes('auth')) {
    return 'Claude API 키가 유효하지 않습니다. Vercel 환경변수(ANTHROPIC_API_KEY)를 확인해 주세요.';
  }
  if (status === 400 || msg.includes('image') || msg.includes('media')) {
    return '이미지 형식을 처리할 수 없습니다. JPG 또는 PNG 파일을 사용해 주세요.';
  }
  if (status >= 500) {
    return 'AI 서버에 일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
  }
  return 'AI 분석 중 알 수 없는 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST')   { return res.status(405).json({ success: false, error: 'Method not allowed' }); }

  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    return res.status(500).json({
      success: false,
      error: '서버 설정 오류: ANTHROPIC_API_KEY 환경변수가 없습니다. 관리자에게 문의해 주세요.',
    });
  }

  const { images, memo } = req.body || {};
  if (!Array.isArray(images) || !images.length) {
    return res.status(400).json({ success: false, error: '이미지 데이터가 없습니다.' });
  }

  // 최대 5장만 처리 (과부하 방지)
  const targets = images.slice(0, 5).filter(img => img?.base64 && img?.mimeType);
  if (!targets.length) {
    return res.status(400).json({ success: false, error: '유효한 이미지 데이터가 없습니다.' });
  }

  // ── Claude content 배열: 이미지들 + 텍스트 프롬프트 ─────────
  const userContent = [
    // 이미지 블록들 (image 타입)
    ...targets.map(img => ({
      type:   'image',
      source: {
        type:       'base64',
        media_type: img.mimeType,
        data:        img.base64,
      },
    })),
    // 분석 요청 텍스트
    {
      type: 'text',
      text: `위 아동복 착장(코디) 사진들을 종합적으로 분석해서 전체적인 톤앤매너와 공통된 무드를 파악한 뒤, 아래 JSON 형식으로 답해줘.
${memo ? `\n[촬영 담당자 소구점 / 참고 메모]: ${memo}\n위 메모를 분석에 적극 반영해줘.` : ''}

{
  "targetGender": "여아/남아/공용 중 하나",
  "targetSize": 110,
  "styleTags": ["태그1", "태그2", "태그3"],
  "conceptSuggestion": "이 착장 묶음에 어울리는 촬영 컨셉 제안 (1~2문장, 한국어)",
  "studioRecommendation": "이 컨셉에 가장 잘 맞는 스튜디오 타입 (예: '자연광 가정집 스튜디오', '화이트 호리존 + 야외 공원', '빈티지 유럽풍 실내')"
}

각 필드 기준:
- targetGender: 착장 스타일 기반 추정 ("여아", "남아", "공용")
- targetSize: 착장에 어울리는 아동 키 (숫자만, 예: 100, 110, 120, 130, 140)
- styleTags: 전체 착장의 공통 무드 키워드 배열 (["러블리", "캐주얼", "스트릿", "모던", "내추럴", "시크", "스포티", "클래식"] 중 최대 3개)
- conceptSuggestion: 이 코디 묶음으로 연출할 수 있는 촬영 컨셉 아이디어 (1~2문장)
- studioRecommendation: 이 착장과 컨셉에 가장 어울리는 스튜디오 타입. 가정집/빈티지/유럽풍/모던/숲속/한옥/학교/병원/카페/옥상/바다/호리존/야외 중 1~2가지 조합으로 구체적으로 제안`,
    },
  ];

  // ── Anthropic Messages API 호출 ──────────────────────────────
  let claudeRes;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':          ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: 'You are a children\'s fashion analyst. You must respond ONLY with a valid JSON object. Do not include any markdown formatting like ```json. Do not add any explanation before or after the JSON. Output the raw JSON object only.',
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: AbortSignal.timeout(55_000),
    });
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

  // ── HTTP 상태 에러 처리 ───────────────────────────────────────
  if (!claudeRes.ok) {
    let errMessage = '';
    try {
      const errBody = await claudeRes.json();
      errMessage = errBody.error?.message || '';
    } catch { /* JSON 파싱 실패 시 무시 */ }

    const koreanMsg = toKoreanError(claudeRes.status, errMessage);
    console.error(`[analyze-outfit] Claude HTTP ${claudeRes.status}: ${errMessage}`);
    return res.status(502).json({ success: false, error: koreanMsg });
  }

  // ── 응답 파싱 ─────────────────────────────────────────────────
  let data;
  try {
    data = await claudeRes.json();
  } catch (parseErr) {
    console.error('[analyze-outfit] 응답 JSON 파싱 실패:', parseErr.message);
    return res.status(502).json({
      success: false,
      error: 'AI 서버 응답을 처리하는 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.',
    });
  }

  // ── 텍스트 추출 (Claude: content[0].text) ────────────────────
  const rawText = data.content?.[0]?.text || '';
  if (!rawText) {
    console.warn('[analyze-outfit] Claude 빈 응답:', JSON.stringify(data).slice(0, 200));
    return res.status(502).json({
      success: false,
      error: 'AI가 분석 결과를 반환하지 않았습니다. 다시 시도해 주세요.',
    });
  }

  // ── 마크다운 잔여물 제거 후 JSON 추출 ────────────────────────
  const cleanText = rawText
    .replace(/```json/gi, '')
    .replace(/```/gi, '')
    .trim();
  const jsonMatch = cleanText.match(/\{[\s\S]*\}/);
  let analysis = {};
  if (jsonMatch) {
    try { analysis = JSON.parse(jsonMatch[0]); } catch { analysis = {}; }
  }

  // ── 기본값 보정 ───────────────────────────────────────────────
  analysis.targetGender        = analysis.targetGender        || '여아';
  analysis.targetSize          = parseInt(analysis.targetSize) || 110;
  analysis.styleTags           = Array.isArray(analysis.styleTags) ? analysis.styleTags.slice(0, 5) : [];
  analysis.conceptSuggestion   = analysis.conceptSuggestion   || '';
  analysis.studioRecommendation = analysis.studioRecommendation || '';

  return res.status(200).json({ success: true, analysis });
}
