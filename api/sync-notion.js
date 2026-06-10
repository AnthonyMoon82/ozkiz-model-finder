export const config = { maxDuration: 60 };

import { Client } from '@notionhq/client';
import { createClient } from '@supabase/supabase-js';

// ==========================================
// 1. 환경변수 및 초기 세팅
// ==========================================
// 백엔드 전용 권한인 service_role 키를 사용하여 RLS(보안정책) 우회
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://qbrpjngmuxcybhnogkfr.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY 
);

export default async function handler(req, res) {
  // CORS 처리
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // POST 요청만 허용
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  if (!NOTION_TOKEN) {
    return res.status(500).json({ error: 'NOTION_TOKEN이 Vercel 환경변수에 설정되지 않았습니다.' });
  }

  const notion = new Client({ auth: NOTION_TOKEN });

  // 환경변수 이름 혼용 방어: NOTION_DB_ID가 있으면 모델 DB로 간주
  const databases = [
    { id: process.env.NOTION_MODEL_DB_ID || process.env.NOTION_DB_ID, type: 'model' },
    { id: process.env.NOTION_OUTSOURCE_DB_ID, type: 'outsource' },
    { id: process.env.NOTION_STUDIO_DB_ID, type: 'studio' }
  ].filter(db => db.id); // ID가 있는 DB만 필터링

  if (databases.length === 0) {
     return res.status(500).json({ error: '동기화할 NOTION DB ID가 Vercel 환경변수에 하나도 없습니다.' });
  }

  let totalFetched = 0;
  let totalUpserted = 0;
  let imagesOK = 0;

  try {
    for (const db of databases) {
      let hasMore = true;
      let nextCursor = undefined;

      // 페이지네이션을 통해 노션 DB의 모든 항목 가져오기
      while (hasMore) {
        const response = await notion.databases.query({
          database_id: db.id,
          start_cursor: nextCursor,
        });

        const pages = response.results;
        totalFetched += pages.length;

        // 각 페이지(모델 1명)마다 병렬/순차 처리
        for (const page of pages) {
          try {
            const props = page.properties;
            
            // 노션 프로퍼티 파싱 헬퍼 함수
            const getVal = (keys, type) => {
              for (const k of keys) {
                const p = props[k];
                if (!p) continue;
                if (type === 'title' && p.title?.length) return p.title.map(t => t.plain_text).join('');
                if (type === 'rich_text' && p.rich_text?.length) return p.rich_text.map(t => t.plain_text).join('');
                if (type === 'select' && p.select) return p.select.name;
                if (type === 'multi_select' && p.multi_select) return p.multi_select.map(s => s.name);
                if (type === 'number' && p.number !== null) return String(p.number);
                if (type === 'files' && p.files) return p.files;
              }
              return '';
            };

            // 노션 이미지(임시) -> Supabase 다이렉트 업로드 (Migration)
            const files = getVal(['사진', '이미지', 'Files', '프로필'], 'files') || [];
            const permanentImageUrls = [];

            for (const file of files) {
              const fileUrl = file.type === 'file' ? file.file.url : file.external?.url;
              if (!fileUrl) continue;

              try {
                const imgRes = await fetch(fileUrl);
                if (!imgRes.ok) continue;
                const arrayBuffer = await imgRes.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                const ext = 'jpg';
                const safeName = `notion_sync/${db.type}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.${ext}`;

                const { error: uploadErr } = await supabase.storage
                  .from('model-photos')
                  .upload(safeName, buffer, {
                    contentType: imgRes.headers.get('content-type') || 'image/jpeg',
                    upsert: true
                  });

                if (!uploadErr) {
                  const { data: publicData } = supabase.storage.from('model-photos').getPublicUrl(safeName);
                  if (publicData?.publicUrl) {
                    permanentImageUrls.push(publicData.publicUrl);
                    imagesOK++;
                  }
                }
              } catch (imgError) {
                console.error('이미지 업로드 실패:', imgError);
              }
            }

            // 데이터 매핑 (DB 타입별 속성 추출)
            const fullName = getVal(['이름', 'Name', '모델명', '성명'], 'title');
            if (!fullName) continue;

            const rawInsta = getVal(['인스타그램', '인스타', 'Instagram', 'SNS'], 'rich_text') || getVal(['인스타그램', '인스타'], 'url') || '';
            const username = rawInsta.replace(/https?:\/\/(?:www\.)?instagram\.com\//i,'').replace(/\?.*/,'').replace(/\//g,'').replace(/^@/,'').trim();

            let postData = {
              id: `notion_${page.id.replace(/-/g, '')}`,
              fullName: fullName,
              username: username || fullName.replace(/\s/g, ''),
              images: permanentImageUrls, 
              imgUrl: permanentImageUrls[0] || '', 
              permalink: username ? `https://www.instagram.com/${username}/` : '',
              timestamp: page.created_time,
              source: 'notion',
              _source: 'notion',
              _real: false,
              db_type: db.type,
              ratings: { nicole: 0, rachel: 0, stella: 0 },
              likes: 0, comments: 0, followers: null,
            };

            if (db.type === 'model') {
              postData.height = getVal(['키(cm)', '키', 'height'], 'rich_text') || getVal(['키'], 'number');
              postData.weight = getVal(['체중(Kg)', '몸무게', 'weight'], 'rich_text') || getVal(['체중'], 'number');
              postData.footSize = getVal(['발사이즈(mm)', '발사이즈'], 'rich_text') || getVal(['발사이즈'], 'number');
              postData.clothesSize = getVal(['사이즈', '옷사이즈'], 'select') || getVal(['사이즈'], 'rich_text');
              postData.birthDate = getVal(['출생년도', '생년월일', '나이'], 'rich_text');
              postData.gender = getVal(['성별'], 'select');
              postData.nationality = getVal(['국적'], 'select') || '한국';
              postData.phone = getVal(['연락처', '전화번호'], 'rich_text');
              postData.location = getVal(['거주지', '주소'], 'rich_text');
              postData.category = getVal(['카테고리', '분류'], 'select');
              postData.status = getVal(['진행여부', 'Status'], 'select') || '미정';
              postData.fee = getVal(['촬영료', '페이'], 'rich_text');
              postData.memo = getVal(['코멘트', '메모', '비고'], 'rich_text');
              
              const bioArr = [
                postData.height && `키 ${postData.height}`,
                postData.weight && `몸무게 ${postData.weight}`,
                postData.birthDate
              ].filter(Boolean);
              postData.biography = bioArr.join(' / ');
              postData.caption = [postData.memo, postData.category].filter(Boolean).join(' | ');

            } else if (db.type === 'outsource') {
              postData.category = getVal(['스텝유형'], 'select');
              postData.status = getVal(['진행유무'], 'select');
              postData.contact = getVal(['연락', '연락처'], 'rich_text');
              postData.pay = getVal(['시간당 페이', '페이'], 'rich_text') || getVal(['시간당 페이'], 'number');
              postData.lastShootDate = getVal(['마지막 촬영일'], 'date') || getVal(['마지막 촬영일'], 'rich_text');
              postData.memo = getVal(['코멘트', '메모'], 'rich_text');
              postData.biography = [postData.category, postData.contact].filter(Boolean).join(' / ');
              postData.caption = postData.memo;

            } else if (db.type === 'studio') {
              postData.studioType = getVal(['스튜디오유형'], 'select');
              postData.address = getVal(['주소'], 'rich_text');
              postData.price = getVal(['렌탈료(1h)', '렌탈료'], 'rich_text');
              postData.website = getVal(['HOME', '홈페이지'], 'url') || getVal(['HOME'], 'rich_text');
              postData.sns = username;
              postData.concept = getVal(['분위기', '컨셉'], 'multi_select') || [];
              postData.memo = getVal(['💬코멘트', '코멘트'], 'rich_text');
              postData.biography = [postData.studioType, postData.address].filter(Boolean).join(' / ');
              postData.caption = postData.memo;
            }

            // Supabase Database에 안전하게 저장 (upsert)
            const { error: upsertErr } = await supabase
              .from('saved_models')
              .upsert({ id: postData.id, post_data: postData }, { onConflict: 'id' });

            if (!upsertErr) totalUpserted++;

          } catch (itemError) {
            console.error(`항목 매핑/저장 실패 (Page ID: ${page.id}):`, itemError);
          }
        }

        nextCursor = response.next_cursor;
        hasMore = response.has_more;
      }
    }

    return res.status(200).json({ 
      success: true, 
      message: `전체 DB 마이그레이션 완료! (조회: ${totalFetched}명, 저장: ${totalUpserted}명, 사진: ${imagesOK}장)`,
      total: totalFetched,
      upserted: totalUpserted,
      imagesOK: imagesOK
    });

  } catch (error) {
    console.error('노션 동기화 에러:', error);
    return res.status(500).json({ error: error.message || '서버 내부 오류가 발생했습니다.' });
  }
}
