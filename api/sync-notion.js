export const config = { maxDuration: 60 };

import { Client } from '@notionhq/client';
import { createClient } from '@supabase/supabase-js';

// 1. 초기 세팅
const supabase = createClient(
  process.env.SUPABASE_URL || 'https://qbrpjngmuxcybhnogkfr.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY 
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const NOTION_TOKEN = process.env.NOTION_TOKEN;
  if (!NOTION_TOKEN) return res.status(500).json({ error: 'NOTION_TOKEN 누락' });

  const notion = new Client({ auth: NOTION_TOKEN });

  const databases = [
    { id: process.env.NOTION_MODEL_DB_ID || process.env.NOTION_DB_ID, type: 'model' },
    { id: process.env.NOTION_OUTSOURCE_DB_ID, type: 'outsource' },
    { id: process.env.NOTION_STUDIO_DB_ID, type: 'studio' }
  ].filter(db => db.id);

  if (databases.length === 0) return res.status(500).json({ error: 'NOTION DB ID 누락' });

  let totalFetched = 0, totalUpserted = 0, imagesOK = 0;

  try {
    for (const db of databases) {
      let hasMore = true;
      let nextCursor = undefined;

      while (hasMore) {
        const response = await notion.databases.query({
          database_id: db.id,
          start_cursor: nextCursor,
        });

        const pages = response.results;
        totalFetched += pages.length;

        await Promise.all(pages.map(async (page) => {
          try {
            const props = page.properties;
            
            // 💡 이모지가 포함된 속성 이름도 유연하게 찾도록 수정
            const getVal = (keys, type) => {
              for (const [propName, p] of Object.entries(props)) {
                if (keys.some(k => propName.includes(k))) {
                   if (type === 'title' && p.type === 'title' && p.title?.length) return p.title.map(t => t.plain_text).join('');
                   if (type === 'rich_text' && p.type === 'rich_text' && p.rich_text?.length) return p.rich_text.map(t => t.plain_text).join('');
                   if (type === 'select' && p.type === 'select' && p.select) return p.select.name;
                   if (type === 'multi_select' && p.type === 'multi_select' && p.multi_select) return p.multi_select.map(s => s.name);
                   if (type === 'number' && p.type === 'number' && p.number !== null) return String(p.number);
                   if (type === 'files' && p.type === 'files' && p.files) return p.files;
                   if (type === 'url' && p.type === 'url' && p.url) return p.url;
                }
              }
              return '';
            };

            // 1. 속성(Properties)에서 이미지 URL 추출 (이모지 포함 검색)
            const propFiles = getVal(['이미지', '사진', 'Files', '프로필'], 'files') || [];
            let allRawUrls = propFiles.map(f => f.type === 'file' ? f.file.url : f.external?.url).filter(Boolean);

            // 2. 🚀 노션 페이지 본문(Blocks)에서 이미지 URL 추가 추출
            try {
              let blockCursor = undefined;
              let hasMoreBlocks = true;
              while(hasMoreBlocks) {
                const blockRes = await notion.blocks.children.list({
                  block_id: page.id,
                  start_cursor: blockCursor
                });
                const imageBlocks = blockRes.results.filter(b => b.type === 'image');
                for (const img of imageBlocks) {
                  const url = img.image.type === 'file' ? img.image.file.url : img.image.external.url;
                  if (url) allRawUrls.push(url);
                }
                blockCursor = blockRes.next_cursor;
                hasMoreBlocks = blockRes.has_more;
              }
            } catch (blockErr) {
               console.error(`본문 블록 읽기 실패 (${page.id}):`, blockErr);
            }

            // 중복 제거
            allRawUrls = [...new Set(allRawUrls)];

            // 3. 추출된 모든 이미지를 Supabase Storage로 업로드
            const permanentImageUrls = (await Promise.all(allRawUrls.map(async (fileUrl) => {
              try {
                const imgRes = await fetch(fileUrl);
                if (!imgRes.ok) return null;
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
                    imagesOK++;
                    return publicData.publicUrl;
                  }
                }
              } catch (imgError) {
                 return null;
              }
              return null;
            }))).filter(Boolean);

            const fullName = getVal(['이름', 'Name', '모델명', '성명'], 'title');
            if (!fullName) return;

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
              postData.height = getVal(['키', 'height'], 'rich_text') || getVal(['키'], 'number');
              postData.weight = getVal(['체중', '몸무게', 'weight'], 'rich_text') || getVal(['체중'], 'number');
              postData.footSize = getVal(['발사이즈', '발 사이즈'], 'rich_text') || getVal(['발사이즈'], 'number');
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
              const bioArr = [postData.height && `키 ${postData.height}`, postData.weight && `몸무게 ${postData.weight}`, postData.birthDate].filter(Boolean);
              postData.biography = bioArr.join(' / ');
              postData.caption = [postData.memo, postData.category].filter(Boolean).join(' | ');
            } else if (db.type === 'outsource') {
              postData.category = getVal(['스텝유형'], 'select');
              postData.status = getVal(['진행유무'], 'select');
              postData.contact = getVal(['연락', '연락처'], 'rich_text');
              postData.pay = getVal(['페이'], 'rich_text') || getVal(['페이'], 'number');
              postData.lastShootDate = getVal(['마지막 촬영일'], 'date') || getVal(['촬영일'], 'rich_text');
              postData.memo = getVal(['코멘트', '메모'], 'rich_text');
              postData.biography = [postData.category, postData.contact].filter(Boolean).join(' / ');
              postData.caption = postData.memo;
            } else if (db.type === 'studio') {
              postData.studioType = getVal(['스튜디오유형'], 'select');
              postData.address = getVal(['주소'], 'rich_text');
              postData.price = getVal(['렌탈료'], 'rich_text');
              postData.website = getVal(['HOME', '홈페이지'], 'url') || getVal(['HOME'], 'rich_text');
              postData.sns = username;
              postData.concept = getVal(['분위기', '컨셉'], 'multi_select') || [];
              postData.memo = getVal(['코멘트', '메모'], 'rich_text');
              postData.biography = [postData.studioType, postData.address].filter(Boolean).join(' / ');
              postData.caption = postData.memo;
            }

            const { error: upsertErr } = await supabase.from('saved_models').upsert({ id: postData.id, post_data: postData }, { onConflict: 'id' });
            if (!upsertErr) totalUpserted++;

          } catch (itemError) {
             console.error(`항목 매핑 에러:`, itemError);
          }
        }));

        nextCursor = response.next_cursor;
        hasMore = response.has_more;
      }
    }

    return res.status(200).json({ 
      success: true, 
      message: `초고속 마이그레이션 완료! (조회: ${totalFetched}명, 사진: ${imagesOK}장 업로드)`,
      total: totalFetched,
      upserted: totalUpserted,
      imagesOK: imagesOK
    });

  } catch (error) {
    console.error('노션 동기화 에러:', error);
    return res.status(500).json({ error: error.message || '서버 내부 오류가 발생했습니다.' });
  }
}
