/**
 * /api/sync-notion.js  —  OzKiz Casting CRM  |  노션 → Supabase 완전 이사 파이프라인
 * ══════════════════════════════════════════════════════════════════════════════════
 *
 *  ✅ 필수 Vercel 환경변수 (Settings → Environment Variables)
 *  ─────────────────────────────────────────────────────────
 *  NOTION_TOKEN              노션 통합(Integration) 시크릿 토큰
 *                            예) secret_abcde12345...
 *                            👉 https://www.notion.so/my-integrations 에서 발급
 *
 *  NOTION_DB_ID              동기화할 노션 데이터베이스 ID (URL의 32자리 hex)
 *                            예) 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d
 *
 *  SUPABASE_URL              Supabase 프로젝트 URL
 *                            예) https://xyzxyzxyz.supabase.co
 *
 *  SUPABASE_SERVICE_ROLE_KEY  ⚠️  서비스 롤 키 (anon 키 아님!)
 *                            Storage RLS를 우회해 서버에서 업로드하려면 반드시 이 키 사용
 *                            예) eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
 *                            👉 Supabase → Settings → API → service_role
 *
 *  ──────────────────────────────────────────────────────────
 *  ℹ️  Vercel 함수 타임아웃
 *     이미지가 많으면 기본 10초로 부족합니다.
 *     vercel.json 에서 maxDuration 을 늘려두세요. (아래 vercel.json 참고)
 *     - Hobby 플랜: 최대 60초
 *     - Pro 플랜:   최대 300초
 * ══════════════════════════════════════════════════════════════════════════════════
 */

// Vercel 함수 최대 실행 시간 (초) — vercel.json maxDuration 과 동일하게 맞출 것
export const config = { maxDuration: 60 };

const { Client }       = require('@notionhq/client');
const { createClient } = require('@supabase/supabase-js');

// ── Supabase Storage 버킷 & 폴더 ──────────────────────────
const BUCKET = 'model-photos';
const FOLDER = 'notion_sync';

// ── 이미지로 인식할 노션 속성 키 목록 (우선순위 순) ──────────
const IMAGE_PROP_KEYS = [
  '사진', '이미지', '프로필사진', '대표사진',
  'Photos', 'Images', 'Photo', 'Image',
  '파일', '첨부', '첨부파일', 'Attachment', 'Files', 'file',
];

// ════════════════════════════════════════════════════════════
//  메인 핸들러
// ════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // ── 환경변수 검증 ────────────────────────────────────────
  const NOTION_TOKEN  = process.env.NOTION_TOKEN;
  const NOTION_DB_ID  = process.env.NOTION_DB_ID;
  const SUPABASE_URL  = process.env.SUPABASE_URL;
  // 서비스 롤 키 우선, 없으면 기존 SUPABASE_KEY 로 폴백
  const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY
                     || process.env.SUPABASE_KEY;

  if (!NOTION_TOKEN || !NOTION_DB_ID || !SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({
      error: [
        '환경변수가 누락됐습니다. 아래 항목을 Vercel에서 확인하세요:',
        !NOTION_TOKEN  && '  ❌ NOTION_TOKEN',
        !NOTION_DB_ID  && '  ❌ NOTION_DB_ID',
        !SUPABASE_URL  && '  ❌ SUPABASE_URL',
        !SUPABASE_KEY  && '  ❌ SUPABASE_SERVICE_ROLE_KEY',
      ].filter(Boolean).join('\n'),
    });
  }

  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.warn('[sync-notion] ⚠️  SUPABASE_SERVICE_ROLE_KEY 가 없어 SUPABASE_KEY 로 폴백합니다. Storage RLS 오류가 발생할 수 있어요.');
  }

  const notion   = new Client({ auth: NOTION_TOKEN });
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // ════════════════════════════════════════════════════════════
  //  유틸리티 함수들
  // ════════════════════════════════════════════════════════════

  /** 노션 텍스트 계열 속성 → 문자열 추출 */
  function getText(prop) {
    if (!prop) return '';
    switch (prop.type) {
      case 'title':        return (prop.title        || []).map(t => t.plain_text).join('');
      case 'rich_text':    return (prop.rich_text    || []).map(t => t.plain_text).join('');
      case 'number':       return prop.number   != null ? String(prop.number)   : '';
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

  /** 여러 키를 순서대로 시도해 첫 번째 값 반환 */
  function pick(props, ...keys) {
    for (const key of keys) {
      const v = getText(props[key]);
      if (v) return v;
    }
    return '';
  }

  /** Files & media 속성 → URL 배열 추출 */
  function extractFileUrls(prop) {
    if (!prop || prop.type !== 'files') return [];
    return (prop.files || []).map(f => {
      if (f.type === 'file')     return f.file?.url     || null; // 노션 내부 호스팅 (임시 URL)
      if (f.type === 'external') return f.external?.url || null; // 외부 링크 (영구 URL)
      return null;
    }).filter(Boolean);
  }

  /** URL에서 확장자 추론 */
  function guessExt(url) {
    try {
      const p = new URL(url).pathname.split('?')[0];
      const ext = p.split('.').pop().toLowerCase();
      return ['jpg','jpeg','png','webp','gif','avif'].includes(ext) ? ext : 'jpg';
    } catch { return 'jpg'; }
  }

  /** 확장자 → MIME 타입 */
  function toMime(ext) {
    return ({ jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png',
               webp:'image/webp', gif:'image/gif', avif:'image/avif' })[ext] || 'image/jpeg';
  }

  /**
   * 노션 임시 이미지 URL → 다운로드 → Supabase Storage 업로드 → 영구 publicUrl 반환
   */
  async function migrateImage(tempUrl) {
    // 1. 이미지 다운로드
    const resp = await fetch(tempUrl, {
      headers: { 'User-Agent': 'OzKiz-Sync-Bot/1.0' },
      signal: AbortSignal.timeout(15_000), // 15초 타임아웃
    });
    if (!resp.ok) {
      throw new Error(`다운로드 실패 HTTP ${resp.status} — ${tempUrl.slice(0, 80)}`);
    }
    const buffer = Buffer.from(await resp.arrayBuffer());

    // 2. 저장 경로 (충돌 없는 고유 이름)
    const ext    = guessExt(tempUrl);
    const random = Math.random().toString(36).slice(2, 9);
    const path   = `${FOLDER}/${Date.now()}_${random}.${ext}`;

    // 3. Supabase Storage 업로드
    const { error: upErr } = await supabase.storage
      .from(BUCKET)
      .upload(path, buffer, { contentType: toMime(ext), upsert: false });

    if (upErr) throw new Error(`Storage 업로드 실패 — ${upErr.message}`);

    // 4. 영구 publicUrl 반환
    const { data: { publicUrl } } = supabase.storage.from(BUCKET).getPublicUrl(path);
    return publicUrl;
  }

  /**
   * 노션 페이지의 모든 Files 속성을 탐색해 URL 배열 반환
   *  - IMAGE_PROP_KEYS 에서 먼저 탐색
   *  - 없으면 files 타입 속성 전체 스캔
   */
  function findAllFileUrls(props) {
    // 알려진 키에서 우선 탐색
    for (const key of IMAGE_PROP_KEYS) {
      if (props[key]) {
        const urls = extractFileUrls(props[key]);
        if (urls.length) return urls;
      }
    }
    // 알 수 없는 키 전체 스캔
    for (const prop of Object.values(props)) {
      if (prop?.type === 'files') {
        const urls = extractFileUrls(prop);
        if (urls.length) return urls;
      }
    }
    return [];
  }

  /**
   * 노션 임시 URL 여부 판별
   * (S3 presigned URL = 1시간 만료)
   */
  function isNotionTempUrl(url) {
    return url.includes('secure.notion-static.com')
        || url.includes('prod-files-secure.s3')
        || url.includes('.amazonaws.com/');
  }

  // ════════════════════════════════════════════════════════════
  //  1단계 — 노션 DB 전체 페이지 조회 (페이지네이션 완전 처리)
  // ════════════════════════════════════════════════════════════
  let pages  = [];
  let cursor = undefined;
  try {
    do {
      const resp = await notion.databases.query({
        database_id: NOTION_DB_ID,
        start_cursor: cursor,
        page_size: 100,
      });
      pages  = pages.concat(resp.results);
      cursor = resp.has_more ? resp.next_cursor : undefined;
    } while (cursor);
  } catch (e) {
    return res.status(500).json({ error: `노션 DB 조회 실패: ${e.message}` });
  }

  // ════════════════════════════════════════════════════════════
  //  2단계 — 페이지별 변환 + 이미지 이사 + Supabase upsert
  //  (각 항목을 독립 try-catch 로 감싸 한 건 실패가 전체에 영향 없도록)
  // ════════════════════════════════════════════════════════════
  let upserted = 0, failed = 0, imagesOK = 0, imagesFailed = 0;
  const errorLog = []; // 최대 20건 수집

  for (const page of pages) {
    try {
      const p  = page.properties;
      const id = `notion_${page.id.replace(/-/g, '')}`;

      // ── 텍스트 속성 매핑 (CSV 파서와 동일 규칙) ─────────
      const fullName    = pick(p, '이름','Name','name','모델명','성명');
      const rawInsta    = pick(p, '인스타ID','인스타그램','Instagram','@ID','username','인스타','SNS');
      const username    = rawInsta
        .replace(/^@/, '')
        .replace(/https?:\/\/[^/]*instagram\.com\//i, '')
        .trim();
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
        height    && `키 ${height}`,
        weight    && `몸무게 ${weight}`,
        birthDate,
        footSize  && `발 ${footSize}`,
      ].filter(Boolean).join(' / ');

      // ── 이미지 이사 ─────────────────────────────────────
      const rawFileUrls = findAllFileUrls(p);
      const permanentUrls = [];

      for (const url of rawFileUrls) {
        if (!isNotionTempUrl(url)) {
          // 외부(external) URL은 만료 없음 → 그대로 사용
          permanentUrls.push(url);
          continue;
        }
        // 노션 임시 URL → Supabase Storage로 이사
        try {
          const publicUrl = await migrateImage(url);
          permanentUrls.push(publicUrl);
          imagesOK++;
        } catch (imgErr) {
          // 이미지 1장 실패 → 경고 기록 후 계속 진행
          console.warn(`[img-skip] ${id}: ${imgErr.message}`);
          imagesFailed++;
        }
      }

      // ── post_data 완성 ───────────────────────────────────
      const postData = {
        id,
        username:    username || fullName.replace(/\s/g, '') || '알수없음',
        fullName,
        biography,
        caption:     [note, category, phone].filter(Boolean).join(' | '),

        // 이미지: Supabase Storage 영구 URL 우선
        imgUrl:      permanentUrls[0] || '',   // 하위 호환 (카드 썸네일)
        images:      permanentUrls,            // 갤러리 배열

        permalink:   username ? `https://www.instagram.com/${username}/` : '',
        likes:       0,
        comments:    0,
        followers:   null,
        timestamp:   page.created_time,
        type:        'Notion',
        _real:       false,

        // 탭/소스 구분
        source:      'notion',
        _source:     'notion',
        db_type:     'model',

        // 상세 필드
        height, weight, footSize, shoeSize: footSize,
        clothesSize, birthDate, gender, nationality,
        phone, location, category, shootDate, fee, status,
        comment: note,

        // 별점 초기값
        ratings: { nicole: 0, rachel: 0, stella: 0 },

        // 노션 메타
        notionId:    page.id,
        notionUrl:   page.url,
      };

      // ── Supabase upsert ──────────────────────────────────
      const { error: dbErr } = await supabase
        .from('saved_models')
        .upsert({ id, post_data: postData }, { onConflict: 'id' });

      if (dbErr) throw new Error(`DB upsert 실패: ${dbErr.message}`);
      upserted++;

    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`[page-skip] ${page.id}: ${msg}`);
      if (errorLog.length < 20) errorLog.push({ pageId: page.id, error: msg });
      failed++;
    }
  }

  // ════════════════════════════════════════════════════════════
  //  3단계 — 결과 반환
  // ════════════════════════════════════════════════════════════
  const summary = [
    `✅ 동기화: ${upserted}건`,
    `🖼️  이미지 이사: ${imagesOK}장 성공 / ${imagesFailed}장 실패`,
    failed > 0 ? `❌ 항목 실패: ${failed}건` : null,
  ].filter(Boolean).join(' | ');

  return res.status(200).json({
    success:       true,
    total:         pages.length,
    upserted,
    failed,
    imagesOK,
    imagesFailed,
    errors:        errorLog,  // 실패 상세 (최대 20건)
    message:       summary,
  });
}
