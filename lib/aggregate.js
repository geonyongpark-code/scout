// 슬랙 수정요청 채널 수집 · 파싱 · 집계 (검증 완료된 규칙)
//
// server.js(API 서버)와 scripts/build.js(정적 대시보드 생성)가 이 모듈을 함께 쓴다.
// server.js 에 있던 코드를 그대로 옮긴 것이며 규칙은 변경하지 않았다.
// 토큰·채널은 환경변수에서 읽는다: SLACK_BOT_TOKEN, CHANNEL_ID

const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = process.env.CHANNEL_ID || "C02CT82KYP8";

// ---------- 오류 항목 분류 규칙 (검증 완료, 우선순위 순) ----------
// 기존 15개 항목의 상대 순서는 그대로 두고, `기타` 로 빠지던 실제 사유 유형 7개를 추가했다.
// (순서가 우선순위다. 먼저 매칭된 항목으로 분류된다.)
export const CATS = [
  ["개인정보(아이디/마스킹)", ["아이디 마스킹", "개인정보", "블러", "후기 아이디"]],
  ["시험성적서/인증", ["시험성적서", "완제품 시험", "kc 인증", "kc인증"]],
  ["제조연월/제조국", ["제조연월", "제조 연월", "출시년월", "제조국", "제조년월"]],
  ["소재/혼용률", ["혼용률", "소재", "가죽"]],
  ["정보제공고시 불일치", ["정보제공고시"]],
  ["친환경/환경성 문구", ["친환경", "eco", "환경", "지속가능"]],
  ["사용기한 문구", ["사용기한", "사용 기한"]],
  ["상세 내 외부정보/링크", ["sns 정보", "타 온라인몰", "오프라인 매장", "방문 구매", "연결이 가능한 링크", "인스타그램", "유튜브", "카카오톡"]],
  ["배송정책 문구", ["무료배송", "유료배송", "배송 정책", "배송정책"]],
  ["카테고리 변경", ["카테고리"]],
  ["성별 수정", ["성별"]],
  ["사이즈 정보/실측", ["사이즈", "실측", "조견표", "옵션 순서", "옵션순서"]],
  ["옵션명/옵션값 불일치", ["옵션명", "옵션값", "상위 옵션"]],
  ["판매옵션 불일치", ["판매 옵션", "옵션과 실제", "안내된 판매", "실제 판매 옵션"]],
  ["상품 설정(아울렛/주문제작/세트)", ["아울렛", "리퍼브", "주문제작", "출고 예정", "출고예정", "세트 상품", "구성 개수"]],
  ["중복/판매불가/반려", ["중복 상품", "판매 불가", "동일 상품", "테스트 상품", "반려"]],
  ["이미지(대표/상세)", ["대표 이미지", "상세 이미지", "대표이미지", "이미지"]],
  ["상품명 표기규칙", ["대괄호", "슬래시", "복수 컬러", "셀럽", "유명인", "협찬"]],
  ["상품명 홍보성/태그성 삭제", ["홍보성", "태그성", "태그 나열", "유사, 중복"]],
  ["상품명 브랜드명 삭제", ["브랜드명은 삭제", "상품명에 브랜드명", "브랜드샵", "브랜드슙"]],
  ["반품비/배송비", ["반품", "배송비"]],
  ["스페셜/IP 선별", ["스페셜", "ip 선별", "ip선별"]],
];
export function classify(reason) {
  const r = (reason || "").toLowerCase();
  for (const [name, kws] of CATS) for (const kw of kws) if (r.includes(kw.toLowerCase())) return name;
  return "기타";
}
function cleanName(s) {
  return String(s || "").split("/")[0].replace(/\(.*?\)/g, "").trim();
}

// ---------- 슬랙 API ----------
async function slack(method, params) {
  const url = "https://slack.com/api/" + method + "?" + new URLSearchParams(params);
  const res = await fetch(url, { headers: { Authorization: "Bearer " + TOKEN } });
  const j = await res.json();
  if (!j.ok) throw new Error(method + " 실패: " + j.error);
  return j;
}
const userCache = new Map();
async function resolveUser(id) {
  if (userCache.has(id)) return userCache.get(id);
  try {
    const j = await slack("users.info", { user: id });
    const p = (j.user && j.user.profile) || {};
    const name = p.display_name || p.real_name || (j.user && j.user.real_name) || id;
    userCache.set(id, name);
    return name;
  } catch (e) {
    userCache.set(id, id);
    return id;
  }
}
async function fetchMessages(oldest, latest) {
  let cursor = null;
  const out = [];
  do {
    const params = { channel: CHANNEL, oldest: String(oldest), latest: String(latest), limit: "200", inclusive: "true" };
    if (cursor) params.cursor = cursor;
    const j = await slack("conversations.history", params);
    out.push(...(j.messages || []));
    cursor = j.response_metadata && j.response_metadata.next_cursor;
  } while (cursor);
  return out;
}

// ---------- 파싱 (검증된 규칙) ----------
function extractMentionIds(text) {
  return [...String(text).matchAll(/<@(U\w+)>/g)].map((m) => m[1]);
}
async function parseMessage(msg, agg) {
  const text = msg.text || "";
  const ids = extractMentionIds(text);
  if (!ids.length) return; // 멘션 없는 메시지는 오류 리포트 아님
  const reviewer = cleanName(await resolveUser(ids[0]));
  const body = text.replace(/<@U\w+>/g, "").split("\n").map((l) => l.trim()).filter((l) => l);
  if (!/\d{5,}/.test(body.join("\n"))) return; // UID 없는 메시지 제외

  let pending = [];
  const groups = [];
  for (const l of body) {
    const hasKr = /[가-힣]{2,}/.test(l);
    if (!hasKr && !l.includes("/") && /\d{5,}/.test(l)) {
      pending.push(...(l.match(/\d{5,}/g) || []));
    } else if (l.includes("/")) {
      const i = l.indexOf("/");
      pending.push(...(l.slice(0, i).match(/\d{5,}/g) || []));
      groups.push({ uids: pending.slice(), reason: l.slice(i + 1).trim() });
      pending = [];
    } else {
      if (pending.length) { groups.push({ uids: pending.slice(), reason: l }); pending = []; }
      else if (groups.length) { groups[groups.length - 1].reason += " " + l; }
    }
  }
  if (pending.length) groups.push({ uids: pending.slice(), reason: "" });

  const dateKST = new Date(Number(msg.ts) * 1000 + 9 * 3600 * 1000).toISOString().slice(0, 10);
  let counted = 0;
  for (const g of groups) {
    if (!g.uids.length) continue;
    const cat = classify(g.reason);
    for (const uid of g.uids) {
      const plat = uid[0] === "4" ? "29cm" : "무신사";
      const rk = reviewer + "||" + plat;
      (agg.rev[rk] = agg.rev[rk] || { name: reviewer, plat, cnt: 0 }).cnt++;
      agg.cat[cat] = (agg.cat[cat] || 0) + 1;
      agg.date[dateKST] = (agg.date[dateKST] || 0) + 1;
      agg.plat[plat] = (agg.plat[plat] || 0) + 1;
      const ck = reviewer + "||" + cat;
      agg.revCat[ck] = (agg.revCat[ck] || 0) + 1;
      // ts 는 집계에 쓰이지 않는 식별용 값(정적 대시보드에서 메시지 수를 세는 데만 사용)
      agg.drill.push({ ts: msg.ts, date: dateKST, reviewer, plat, cat, uid, reason: g.reason });
      agg.total++; counted++;
    }
  }
  if (counted) agg.msgs++;
}

// ---------- 집계 ----------
export async function aggregate(from, to) {
  const oldest = Math.floor(Date.parse(from + "T00:00:00+09:00") / 1000);
  const latest = Math.floor(Date.parse(to + "T23:59:59+09:00") / 1000);
  const msgs = await fetchMessages(oldest, latest);
  const agg = { rev: {}, cat: {}, date: {}, plat: {}, revCat: {}, drill: [], total: 0, msgs: 0 };
  for (const m of msgs) {
    if (m.subtype && m.subtype !== "thread_broadcast") continue; // 시스템 메시지 제외
    await parseMessage(m, agg);
  }
  return {
    from, to,
    total: agg.total,
    msgs: agg.msgs,
    byReviewer: Object.values(agg.rev).sort((a, b) => b.cnt - a.cnt),
    byCategory: Object.entries(agg.cat).map(([cat, cnt]) => ({ cat, cnt })).sort((a, b) => b.cnt - a.cnt),
    byDate: Object.entries(agg.date).map(([date, cnt]) => ({ date, cnt })).sort((a, b) => a.date.localeCompare(b.date)),
    byPlatform: agg.plat,
    reviewerCategory: Object.entries(agg.revCat).map(([k, cnt]) => { const [reviewer, cat] = k.split("||"); return { reviewer, cat, cnt }; }),
    drill: agg.drill,
  };
}

export const hasToken = () => !!TOKEN;
export const channelId = () => CHANNEL;
