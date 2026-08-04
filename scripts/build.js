// 정적 대시보드 생성: 슬랙 수집 -> 집계 -> snapshot.json -> docs/dashboard.html
//
// GitHub Actions(매일 08:00 KST)와 로컬에서 모두 같은 명령으로 돌아간다.
//   node scripts/build.js
//
// 필요한 환경변수: SLACK_BOT_TOKEN (필수), CHANNEL_ID, DAYS(수집 기간, 기본 90일)
// 외부 의존성 없음 — Node 18+ 내장 fetch 만 사용한다.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

try { (await import("dotenv")).default.config(); } catch { /* 로컬에서 .env 를 쓸 때만 필요 */ }
const { aggregate } = await import("../lib/aggregate.js");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DAYS = Number(process.env.DAYS || 90);

if (!process.env.SLACK_BOT_TOKEN) {
  console.error("SLACK_BOT_TOKEN 이 없습니다. (로컬: .env / Actions: 저장소 Secrets)");
  process.exit(1);
}

// ---------- 1) 수집 + 집계 ----------
const kst = (d) => new Date(d.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const now = new Date();
const to = kst(now);
const from = kst(new Date(now.getTime() - (DAYS - 1) * 86400 * 1000));

console.log(`[1/3] 슬랙 수집·집계: ${from} ~ ${to}`);
const r = await aggregate(from, to);
console.log(`      오류 상품 ${r.total}건 · 메시지 ${r.msgs}건 · 원본 ${r.drill.length}행`);
if (!r.drill.length) {
  console.error("수집된 오류 리포트가 없습니다. 봇이 채널에 초대되어 있는지 확인하세요.");
  process.exit(1);
}

// ---------- 2) 스냅샷 (사전 압축) ----------
// 사유·이름·날짜는 행마다 반복되므로 사전으로 빼면 파일이 훨씬 작아진다.
const dict = { ts: [], date: [], rev: [], plat: [], cat: [], reason: [] };
const idx = { ts: new Map(), date: new Map(), rev: new Map(), plat: new Map(), cat: new Map(), reason: new Map() };
const put = (k, v) => {
  const s = v == null ? "" : String(v);
  if (!idx[k].has(s)) { idx[k].set(s, dict[k].length); dict[k].push(s); }
  return idx[k].get(s);
};
const rows = r.drill.map((d) => [put("ts", d.ts), put("date", d.date), put("rev", d.reviewer), put("plat", d.plat), put("cat", d.cat), d.uid, put("reason", d.reason)]);

// 시작일만 실제 데이터가 있는 날로 좁힌다(앞부분이 비어 있으면 빈 구간만 길어진다).
// 종료일은 수집 시점(오늘)으로 둔다 — 그래야 "수집했지만 수정요청이 0건인 날"이 그래프에 보인다.
const dates = dict.date.slice().sort();
const snapshot = {
  from: dates[0], to,
  total: r.total, msgs: r.msgs,
  generatedAt: new Date().toISOString(),
  dict, rows,
};
const snapPath = path.join(root, "snapshot.json");
fs.writeFileSync(snapPath, JSON.stringify(snapshot));
const rawSize = JSON.stringify({ drill: r.drill }).length;
console.log(`[2/3] snapshot.json ${kb(fs.statSync(snapPath).size)} (사전 압축 전 ${kb(rawSize)})`);

// ---------- 3) 조립 ----------
const tplPath = path.join(root, "public", "index.html");
const vendorPath = path.join(root, "vendor", "chart.umd.js");
const outPath = path.join(root, "docs", "dashboard.html");
let html = fs.readFileSync(tplPath, "utf8");
const cdnTag = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.js"></script>';
if (!html.includes(cdnTag)) {
  console.error("템플릿에서 Chart.js 태그를 찾지 못했습니다. public/index.html 을 확인하세요.");
  process.exit(1);
}
html = html.split(cdnTag).join(
  `<script>window.EMBEDDED=${JSON.stringify(snapshot)};</script>\n<script>${fs.readFileSync(vendorPath, "utf8")}</script>`
);
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, html);
console.log(`[3/3] docs/dashboard.html ${kb(fs.statSync(outPath).size)} · 기간 ${snapshot.from} ~ ${snapshot.to} · 외부 요청 0`);

function kb(n) { return Math.round(n / 1024) + " KB"; }
