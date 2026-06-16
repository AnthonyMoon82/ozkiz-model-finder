/**
 * /api/sync-notion.js  —  OzKiz Casting CRM
 * 프론트엔드 주도 청킹(Chunking) 방식 동기화 파이프라인
 * ══════════════════════════════════════════════════════════════════
 *
 *  ✅ 필수 Vercel 환경변수 (Settings → Environment Variables)
 *  ──────────────────────────────────────────────────────────
 *  NOTION_TOKEN               노션 통합 시크릿 토큰 (secret_...)
 *
 *  NOTION_DB_ID_MODEL         모델 DB ID   (dbIndex: 0)
 *                             기존 NOTION_DB_ID 도 폴백으로 인식
 *  NOTION_DB_ID_OUTSOURCE     외주 DB ID   (dbIndex: 1)
 *  NOTION_DB_ID_STUDIO        스튜디오 DB ID (dbIndex: 2)
 *
 *  SUPABASE_URL               Supabase 프로젝트 URL
 *  SUPABASE_SERVICE_ROLE_KEY  서비스 롤 키 (Storage 업로드용, anon 키 아님!)
 *                             ※ 없으면 SUPABASE_KEY 로 폴백 (RLS 오류 가능)
 * ══════════════════════════════════════════════════════════════════
 *
 *  📦 요청 형식 (POST body JSON)
 *  { dbIndex: 0|1|2, cursor: "<notion cursor 문자열>" | null }
 *
 *  📤 응답 형식
 *  {
 *    success: true,
 *    db_type: "model" | "outsource" | "studio",
 *    upserted: number,   // 이번 배치 저장 건수
 *    failed: number,
 *    imagesOK: number,   // 이번 배치 이미지 이사 성공 수
 *    imagesFailed: number,
 *    has_more: boolean,  // 노션에 다음 페이지 존재 여부
 *    next_cursor: string | null,
 *    errors: Array       // 실패 상세 (최대 5건)
 *  }
 * ══════════════════════════════════════════════════════════════════
 */

export const config = { maxDuration: 60 };

const { Client }       = require('@notionhq/client');
const { createClient } = require('@supabase/supabase-js');

const BUCKET = 'model-photos';
const FOLDER = 'notion_sync';

// 이미지 속성으로 인식할 노션 키 목록
const IMAGE_PROP_KEYS = [
  '사진', '이미지', '프로필사진', '대표사진',
  'Photos', 'Images', 'Photo', 'Image',
  '파일', '첨부', '첨부파일', 'Attachment', 'Files', 'file',
];

// dbIndex → { db_type, label } 매핑
const DB_META = [
  { db_type: 'model',     label: '모델 DB' },
  { db_type: 'outsource', label: '외주 DB' },
  { db_type: 'studio',    label: '스튜디오 DB' },
];

// ════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // ── 환경변수 ──────────────────────────────────────────
  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
                    || process.env.SUPABASE_KEY;

  // 3개 DB ID 배열 (없는 항목은 null → 해당 dbIndex 스킵)
  const NOTION_DB_IDS = [
    process.env.NOTION_DB_ID_MODEL     || process.env.NOTION_DB_ID || null,
    process.env.NOTION_DB_ID_OUTSOURCE || null,
    process.env.NOTION_DB_ID_STUDIO    || null,
  ];

  if (!NOTION_TOKEN || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({
      error: [
        '환경변수 누락:',
        !NOTION_TOKEN  && '❌ NOTION_TOKEN',
        !SUPABASE_URL  && '❌ SUPABASE_URL',
        !SUPABASE_KEY  && '❌ SUPABASE_SERVICE_ROLE_KEY',
      ].filter(Boolean).join(' / '),
    });
  }

  // ── 요청 파싱 ────────────────────────────────────────
  const body     = req.body || {};
  const dbIndex  = Number(body.dbIndex ?? 0);
  const cursor   = body.cursor || undefined; // undefined → 처음부터

  if (dbIndex < 0 || dbIndex > 2) {
    return res.status(400).json({ error: 'dbIndex 는 0~2 사이여야 합니다.' });
  }

  const NOTION_DB_ID = NOTION_DB_IDS[dbIndex];
  const { db_type, label } = DB_META[dbIndex];

  // 해당 DB ID가 설정되지 않은 경우 → 빈 성공 반환 (프론트에서 스킵 처리)
  if (!NOTION_DB_ID) {
    return res.status(200).json({
      success: true, db_type, label,
      upserted: 0, failed: 0, imagesOK: 0, imagesFailed: 0,
      has_more: false, next_cursor: null,
      errors: [],
      message: `${label}: NOTION_DB_ID 미설정 → 스킵`,
    });
  }

  const notion   = new Client({ auth: NOTION_TOKEN });
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ════════════════════════════════════════════════════
  //  유틸리티
  // ════════════════════════════════════════════════════

  function getText(prop) {
    if (!prop) return '';
    switch (prop.type) {
      case 'title':        return (prop.title        || []).map(t => t.plain_text).join('');
      case 'rich_text':    return (prop.rich_text    || []).map(t => t.plain_text).join('');
      case 'number':       return prop.number != null ? String(prop.number) : '';
      case 'select':       return prop.select?.name  || '';
      case 'multi_select': return (prop.multi_select || []).map(s => s.name).join(', ');
      case 'url':          return prop.url           || '';
      case 'email':        return prop.email         || '';
      case 'phone_number': return prop.phone_number  || '';
      case 'date':         return prop.date?.start   || '';
      case 'checkbox':     return prop.checkbox ? 'true' : '';
      default:             return '';
    }
  }

  function pick(props, ...keys) {
    for (const key of keys) {
      const v = getText(props[key]);
      if (v) return v;
    }
    return '';
  }

  function extractFileUrls(prop) {
    if (!prop || prop.type !== 'files') return [];
    return (prop.files || []).map(f => {
      if (f.type === 'file')     return f.file?.url     || null;
      if (f.type === 'external') return f.external?.url || null;
      return null;
    }).filter(Boolean);
  }

  function findAllFileUrls(props) {
    for (const key of IMAGE_PROP_KEYS) {
      if (props[key]) {
        const urls = extractFileUrls(props[key]);
        if (urls.length) return urls;
      }
    }
    for (const prop of Object.values(props)) {
      if (prop?.type === 'files') {
        const urls = extractFileUrls(prop);
        if (urls.length) return urls;
      }
    }
    return [];
  }

  function isNotionTempUrl(url) {
    return url.includes('secure.notion-static.com')
        || url.includes('prod-files-secure.s3')
        || url.includes('.amazonaws.com/');
  }

  function guessExt(url) {
    try {
      const p = new URL(url).pathname.split('?')[0];
      const e = p.split('.').pop().toLowerCase();
      return ['jpg','jpeg','png','webp','gif','avif'].includes(e) ? e : 'jpg';
    } catch { return 'jpg'; }
  }

  function toMime(ext) {
    return ({jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',
             webp:'image/webp',gif:'image/gif',avif:'image/avif'})[ext]||'image/jpeg';
  }

  async function migrateImage(tempUrl) {
    const resp = await fetch(tempUrl, {
      headers: { 'User-Agent': 'OzKiz-Sync/1.0' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) throw new Error(`다운로드 실패 HTTP ${resp.status}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const ext    = guessExt(tempUrl);
    const rand   = Math.random().toString(36).slice(2, 8);
    const path   = `${FOLDER}/${Date.now()}_${rand}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from(BUCKET).upload(path, buffer, { contentType: toMime(ext), upsert: false });
    if (upErr) throw new Error(`Storage 업로드 실패: ${upErr.message}`);
    const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return publicUrl;
  }

  // 노션 블록에서 이미지 URL 추출 (본문 이미지)
  async function getBlockImageUrls(pageId) {
    const urls = [];
    try {
      const resp = await notion.blocks.children.list({ block_id: pageId, page_size: 50 });
      for (const block of resp.results || []) {
        if (block.type === 'image') {
          const img = block.image;
          const url = img?.type === 'file'     ? img.file?.url
                    : img?.type === 'external' ? img.external?.url
                    : null;
          if (url) urls.push(url);
        }
      }
    } catch { /* 블록 조회 실패 시 무시 */ }
    return urls;
  }

  // ════════════════════════════════════════════════════
  //  1번 배치 처리 (page_size: 5 → 타임아웃 방지)
  // ════════════════════════════════════════════════════
  let notionResp;
  try {
    notionResp = await notion.databases.query({
      database_id: NOTION_DB_ID,
      start_cursor: cursor,
      page_size: 5,           // ← 핵심: 1회 실행 시간 제한
    });
  } catch (e) {
    return res.status(500).json({ error: `노션 DB 조회 실패: ${e.message}` });
  }

  const pages      = notionResp.results;
  const has_more   = notionResp.has_more;
  const next_cursor = notionResp.next_cursor || null;

  // ════════════════════════════════════════════════════
  //  각 페이지 변환 + 이미지 이사 + upsert
  // ════════════════════════════════════════════════════
  let upserted = 0, failed = 0, imagesOK = 0, imagesFailed = 0;
  const errorLog = [];

  for (const page of pages) {
    try {
      const p  = page.properties;
      const id = `notion_${page.id.replace(/-/g, '')}`;

      // ── 텍스트 속성 매핑 ─────────────────────────────
      const fullName    = pick(p, '이름','Name','name','모델명','성명');
      const rawInsta    = pick(p, '인스타ID','인스타그램','Instagram','@ID','username','인스타','SNS');
      const username    = rawInsta.replace(/^@/,'').replace(/https?:\/\/[^/]*instagram\.com\//i,'').trim();
      const height      = pick(p, '키','Height','height','신장');
      const weight      = pick(p, '몸무게','Weight','weight','체중');
      const footSize    = pick(p, '발사이즈','발 사이즈','FootSize','foot','shoe','발');
      const clothesSize = pick(p, '옷사이즈','옷 사이즈','Size','size','ClothesSize','호수');
      const birthDate   = pick(p, '생년월일','나이','출생','Age','생년','년생','출생연도');
      const gender      = pick(p, '성별','Gender','gender');
      const nationality = pick(p, '국적','Nationality','nationality') || '한국';
      const phone       = pick(p, '연락처','Phone','전화번호','전화','Tel');
      const location    = pick(p, '거주지','주소','Location','지역','address');
      const category    = pick(p, '카테고리','Category','분류','타입');
      const fee         = pick(p, '촬영료','Fee','fee','촬영비','페이');
      const shootDate   = pick(p, '촬영일','ShootDate','촬영날짜','촬영 일자');
      const status      = pick(p, '진행여부','진행 여부','상태','Status','status');
      const note        = pick(p, '코멘트','특징','Notes','메모','비고','특이사항','Memo','comment','Comments');

      const biography = [
        height   && `키 ${height}`,
        weight   && `몸무게 ${weight}`,
        birthDate,
        footSize && `발 ${footSize}`,
      ].filter(Boolean).join(' / ');

      // ── 이미지 수집: 속성 + 본문 블록 ────────────────
      const propUrls  = findAllFileUrls(p);
      const blockUrls = await getBlockImageUrls(page.id);
      const allUrls   = [...new Set([...propUrls, ...blockUrls])]; // 중복 제거

      // ── 이미지 이사 ───────────────────────────────────
      const permanentUrls = [];
      for (const url of allUrls) {
        if (!isNotionTempUrl(url)) {
          permanentUrls.push(url); // 외부 URL은 그대로
          continue;
        }
        try {
          permanentUrls.push(await migrateImage(url));
          imagesOK++;
        } catch (imgErr) {
          console.warn(`[img-skip] ${id}: ${imgErr.message}`);
          imagesFailed++;
        }
      }

      // ── post_data 완성 ────────────────────────────────
      const postData = {
        id,
        username:  username || fullName.replace(/\s/g,'') || '알수없음',
        fullName,
        biography,
        caption:   [note, category, phone].filter(Boolean).join(' | '),
        imgUrl:    permanentUrls[0] || '',
        images:    permanentUrls,
        permalink: username ? `https://www.instagram.com/${username}/` : '',
        likes: 0, comments: 0, followers: null,
        timestamp: page.created_time,
        type: 'Notion', _real: false,
        source: 'notion', _source: 'notion',
        db_type,
        height, weight, footSize, shoeSize: footSize,
        clothesSize, birthDate, gender, nationality,
        phone, location, category, shootDate, fee, status,
        comment: note,
        ratings: { nicole: 0, rachel: 0, stella: 0 },
        notionId:  page.id,
        notionUrl: page.url,
      };

      // ── Supabase upsert ───────────────────────────────
      const { error: dbErr } = await supabase
        .from('saved_models')
        .upsert({ id, post_data: postData }, { onConflict: 'id' });
      if (dbErr) throw new Error(`DB upsert 실패: ${dbErr.message}`);
      upserted++;

    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`[page-skip] ${page.id}: ${msg}`);
      if (errorLog.length < 5) errorLog.push({ pageId: page.id, error: msg });
      failed++;
    }
  }

  return res.status(200).json({
    success: true,
    db_type,
    label,
    upserted,
    failed,
    imagesOK,
    imagesFailed,
    has_more,
    next_cursor,
    errors: errorLog,
    message: `[${label}] ${upserted}건 저장 · 이미지 ${imagesOK}장${has_more ? ' (계속...)' : ' (완료)'}`,
  });
}
