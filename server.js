// 2차검수 오류 분석 웹앱 - 백엔드
// 슬랙 수정요청 채널을 봇 토큰으로 읽어 파싱/집계 후 JSON 반환.
import express from "express";
import dotenv from "dotenv";
import crypto from "node:crypto";
dotenv.config();
// 집계 규칙은 lib/aggregate.js 에 있다. dotenv.config() 이후에 불러야 환경변수가 반영된다.
const { aggregate, hasToken, channelId } = await import("./lib/aggregate.js");

const TOKEN = hasToken();
const CHANNEL = channelId();
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

// ---------- 수집·파싱·집계 ----------
// 검증된 규칙은 lib/aggregate.js 로 분리했다(정적 대시보드 생성 스크립트와 공유).
// 아래에서는 그 모듈의 aggregate() 를 그대로 호출한다.
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
