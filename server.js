// 2차검수 오류 분석 웹앱 - 백엔드
// 슬랙 수정요청 채널을 봇 토큰으로 읽어 파싱/집계 후 JSON 반환.
import express from "express";
import dotenv from "dotenv";
import crypto from "node:crypto";
dotenv.config();

const TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL = process.env.CHANNEL_ID || "C02CT82KYP8";
const PORT = process.env.PORT || 3000;
const CACHE_TTL_SEC = Number(process.env.CACHE_TTL_SEC || 60);

// ---------- 접근 제어 설정 (구글 로그인 + 이메일 허용목록) ----------
const GOOGLE_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const listEnv = (v) => String(v || "").split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
const ALLOWED_EMAILS = listEnv(process.env.ALLOWED_EMAILS);
const ALLOWED_DOMAINS = listEnv(process.env.ALLOWED_DOMAINS);
// 세 값이 모두 있어야 로그인 기능이 켜진다. 없으면 로컬(127.0.0.1)만 열리고 외부 접근은 잠긴다.
const AUTH_ON = !!(GOOGLE_ID && GOOGLE_SECRET && SESSION_SECRET);

if (!TOKEN) {
  console.warn("[경고] SLACK_BOT_TOKEN 이 설정되지 않았습니다. .env 를 확인하세요.");
}

// ---------- 오류 항목 분류 규칙 (검증 완료, 우선순위 순) ----------
// 기존 15개 항목의 상대 순서는 그대로 두고, `기타` 로 빠지던 실제 사유 유형 7개를 추가했다.
// (순서가 우선순위다. 먼저 매칭된 항목으로 분류된다.)
const CATS = [
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
function classify(reason) {
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

// ---------- 집계 엔드포인트 ----------
async function aggregate(from, to) {
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

// ---------- 캐시 (기간별, 분 단위) ----------
// 집계 결과만 캐싱한다. 집계 규칙은 위 코드 그대로이며 캐시는 슬랙 API 호출 횟수만 줄인다.
const cache = new Map(); // "from|to" -> { at:ms, data }
function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.at > CACHE_TTL_SEC * 1000) { cache.delete(key); return null; }
  return e;
}
function cacheSet(key, data) {
  cache.set(key, { at: Date.now(), data });
  if (cache.size > 50) cache.delete(cache.keys().next().value); // 오래된 항목부터 정리
}

// ---------- 접근 제어: 구글 로그인 + 이메일 허용목록 ----------
// 외부 라이브러리 없이 구현한다(추가 의존성 0). 세션은 HMAC 서명된 쿠키 하나.
const htmlEsc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const b64u = (v) => Buffer.from(v).toString("base64url");
const signPart = (data) => crypto.createHmac("sha256", SESSION_SECRET).update(data).digest("base64url");

function makeToken(payload, ttlMs) {
  const body = b64u(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  return body + "." + signPart(body);
}
function readToken(tok) {
  if (!tok || typeof tok !== "string" || !tok.includes(".")) return null;
  const i = tok.lastIndexOf(".");
  const body = tok.slice(0, i), sig = tok.slice(i + 1);
  const expect = signPart(body);
  if (sig.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}
function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const isSecureReq = (req) => (BASE_URL ? BASE_URL.startsWith("https://") : req.protocol === "https");
const cookieOpts = (req, maxAge) => ({ httpOnly: true, sameSite: "lax", secure: isSecureReq(req), maxAge, path: "/" });
const callbackUrl = (req) => (BASE_URL || req.protocol + "://" + req.get("host")) + "/auth/google/callback";
const isLocalReq = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.ip || req.socket.remoteAddress);
function isAllowedEmail(email) {
  if (!ALLOWED_EMAILS.length && !ALLOWED_DOMAINS.length) return false; // 목록이 비면 아무도 통과 못 한다
  const domain = email.split("@")[1] || "";
  return ALLOWED_EMAILS.includes(email) || ALLOWED_DOMAINS.includes(domain);
}
function notice(res, code, title, body, retry) {
  res.status(code).type("html").send(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEsc(title)}</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f5f6f8;
color:#1c1e21;font-family:-apple-system,"Malgun Gothic","Apple SD Gothic Neo",sans-serif}
.b{background:#fff;border:1px solid #e4e6eb;border-radius:12px;padding:28px 30px;max-width:440px;text-align:center}
h1{font-size:17px;margin:0 0 8px}p{font-size:13.5px;color:#65676b;line-height:1.6;margin:0 0 4px}
a{display:inline-block;margin-top:16px;padding:8px 16px;background:#1877f2;color:#fff;text-decoration:none;
border-radius:6px;font-size:13px;font-weight:600}</style></head>
<body><div class="b"><h1>${htmlEsc(title)}</h1><p>${body}</p>
${retry ? '<a href="/auth/google">다시 로그인</a>' : ""}</div></body></html>`);
}

// ---------- 서버 ----------
const app = express();
app.set("trust proxy", 1); // Render 등 프록시 뒤에서 https/클라이언트 IP 를 올바르게 인식

app.get("/auth/google", (req, res) => {
  if (!AUTH_ON) return notice(res, 503, "로그인이 설정되지 않았습니다", "관리자가 구글 로그인 환경변수를 설정해야 합니다.");
  const state = crypto.randomBytes(16).toString("base64url");
  res.cookie("oauth_state", makeToken({ state }, 10 * 60 * 1000), cookieOpts(req, 10 * 60 * 1000));
  const p = new URLSearchParams({
    client_id: GOOGLE_ID, redirect_uri: callbackUrl(req), response_type: "code",
    scope: "openid email", state, prompt: "select_account", access_type: "online",
  });
  if (ALLOWED_DOMAINS.length === 1) p.set("hd", ALLOWED_DOMAINS[0]); // 계정 선택창을 회사 도메인으로 좁힘
  res.redirect("https://accounts.google.com/o/oauth2/v2/auth?" + p);
});

app.get("/auth/google/callback", async (req, res) => {
  try {
    const saved = readToken(readCookies(req).oauth_state);
    res.clearCookie("oauth_state", { path: "/" });
    if (!saved || !req.query.state || saved.state !== req.query.state) {
      return notice(res, 400, "로그인 요청이 만료되었습니다", "처음부터 다시 시도해 주세요.", true);
    }
    if (!req.query.code) return notice(res, 400, "로그인이 취소되었습니다", "구글 로그인을 완료해야 열람할 수 있습니다.", true);

    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code: String(req.query.code), client_id: GOOGLE_ID, client_secret: GOOGLE_SECRET,
        redirect_uri: callbackUrl(req), grant_type: "authorization_code",
      }),
    });
    const tok = await r.json();
    if (!tok.id_token) throw new Error(tok.error_description || tok.error || "id_token 을 받지 못했습니다");
    // id_token 을 구글 토큰 엔드포인트에서 HTTPS 로 직접 받았으므로 서명 검증은 생략 가능(구글 문서 기준).
    // 대신 수신자(aud)가 우리 클라이언트인지, 이메일이 인증된 값인지는 확인한다.
    const claims = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString("utf8"));
    if (claims.aud !== GOOGLE_ID) throw new Error("토큰 수신자가 일치하지 않습니다");
    const email = String(claims.email || "").toLowerCase();
    if (!email || claims.email_verified === false) {
      return notice(res, 403, "이메일을 확인할 수 없습니다", "구글 계정의 이메일 인증 상태를 확인해 주세요.", true);
    }
    if (!isAllowedEmail(email)) {
      console.warn("[접근 거부]", email);
      return notice(res, 403, "열람 권한이 없습니다",
        `<b>${htmlEsc(email)}</b> 계정은 허용목록에 없습니다.<br>관리자에게 열람 권한을 요청하세요.`, true);
    }
    res.cookie("sid", makeToken({ email }, SESSION_HOURS * 3600 * 1000), cookieOpts(req, SESSION_HOURS * 3600 * 1000));
    console.log("[로그인]", email);
    res.redirect("/");
  } catch (e) {
    console.error("로그인 처리 실패:", e);
    notice(res, 500, "로그인 처리 중 오류가 발생했습니다", htmlEsc(e.message || String(e)), true);
  }
});

app.get("/logout", (req, res) => {
  res.clearCookie("sid", { path: "/" });
  notice(res, 200, "로그아웃되었습니다", "다시 열람하려면 로그인하세요.", true);
});

// 게이트: 아래로 내려가는 모든 요청(정적 파일 포함)은 로그인을 통과해야 한다
app.use((req, res, next) => {
  if (req.path === "/api/health") return next(); // 배포 상태 점검용(민감정보 없음)
  if (!AUTH_ON) {
    if (isLocalReq(req)) return next(); // 로컬 개발은 그대로 열어둔다
    return notice(res, 503, "아직 공개할 수 없습니다",
      "구글 로그인이 설정되지 않아 외부 접근을 차단했습니다.<br>관리자가 환경변수를 설정해야 합니다.");
  }
  const sess = readToken(readCookies(req).sid);
  if (sess) { req.user = sess; return next(); }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "login_required" });
  res.redirect("/auth/google");
});

app.get("/api/me", (req, res) => res.json({ authEnabled: AUTH_ON, email: (req.user && req.user.email) || null }));

app.use(express.static("public"));

app.get("/api/errors", async (req, res) => {
  try {
    const to = req.query.to || new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
    const from = req.query.from || to;
    const key = from + "|" + to;
    const hit = req.query.fresh ? null : cacheGet(key);
    if (hit) return res.json({ ...hit.data, cached: true, generatedAt: new Date(hit.at).toISOString() });
    const data = await aggregate(from, to);
    cacheSet(key, data);
    res.json({ ...data, cached: false, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/health", (req, res) =>
  res.json({ ok: true, channel: CHANNEL, hasToken: !!TOKEN, cacheTtlSec: CACHE_TTL_SEC, cachedRanges: cache.size })
);

app.listen(PORT, () => {
  console.log(`2차검수 오류 분석 웹앱 실행: http://localhost:${PORT}`);
  if (AUTH_ON) {
    console.log(`[접근제어] 구글 로그인 켜짐 · 콜백 ${BASE_URL || "(요청 호스트 기준)"}/auth/google/callback`);
    console.log(`[접근제어] 허용 이메일 ${ALLOWED_EMAILS.length}개 · 허용 도메인 ${ALLOWED_DOMAINS.join(", ") || "없음"}`);
    if (!ALLOWED_EMAILS.length && !ALLOWED_DOMAINS.length) {
      console.warn("[경고] ALLOWED_EMAILS/ALLOWED_DOMAINS 가 비어 있어 아무도 로그인할 수 없습니다.");
    }
  } else {
    console.warn("[경고] 구글 로그인 미설정(GOOGLE_CLIENT_ID/SECRET/SESSION_SECRET). 로컬 접속만 열리고 외부 접근은 차단됩니다.");
  }
});
