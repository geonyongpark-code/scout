# 2차검수 오류 분석 웹앱

슬랙 `#카탈로그n세일운영-수정요청` 채널의 수정요청 메시지를 자동 집계해, 1차검수자별 오류량과 자주 틀리는 항목, 기간별 추이를 팀이 실시간으로 함께 보는 웹 페이지.

상세 배경과 규칙은 `기획서.md` 참고.

## 두 가지 방식 (헷갈리지 않게)

만드는 기능은 **하나**다. "1차검수자별·항목별 오류 분석 대시보드". 슬랙은 알림을 보내는 대상이 아니라 **데이터를 읽어오는 출처**일 뿐이다(`#카탈로그n세일운영-수정요청` 채널의 수정요청 메시지). 알림/봇 발신 기능은 없다.

그 대시보드를 사람들에게 보여주는 방법이 두 가지이고, 현재 **A를 선택**했다.

| | A. 정적 HTML + GitHub Pages ← **선택** | B. Render 서버 + 구글 로그인 (보류) |
|---|---|---|
| 결과물 | `docs/dashboard.html` 한 개 파일 | 상시 실행되는 웹 서버 |
| 데이터 | 만들 때의 스냅샷이 파일에 박힘 | 열 때마다 슬랙에서 실시간 |
| 갱신 | 파일을 다시 만들어 올려야 함 | 자동 (열면 최신) |
| 접근 제어 | **없음. 링크를 아는 누구나 볼 수 있음** | 허용한 이메일만 로그인 가능 |
| 준비물 | GitHub 저장소 하나 | 구글 OAuth + Render 계정 |

A가 훨씬 단순하고, 사내에 이미 같은 방식의 대시보드가 있다(`musinsa.github.io/.../dashboard.html`). 단, **공개 범위에 주의**해야 한다 — 아래 참고.

## A. 정적 대시보드 만들기 (현재 방식)

결과물은 `docs/dashboard.html` 이다. Chart.js와 데이터가 모두 파일 안에 인라인으로 들어가 **외부 요청이 0**이고, 인터넷 없이 더블클릭만으로도 열린다.

만드는 과정은 3단계다.

1. **슬랙에서 메시지 수집** — 봇 토큰으로 채널 메시지를 읽는다
2. **집계** — `server.js` 의 검증된 파싱·분류 규칙으로 UID·검수자·오류항목을 뽑아 `snapshot.json` 생성
3. **조립** — 템플릿(`public/index.html`) + Chart.js + 스냅샷을 합쳐 한 개 파일로 만든다

3단계는 Node 없이 바로 실행할 수 있다.

```powershell
powershell -ExecutionPolicy Bypass -File build-dashboard.ps1 -DataPath .\snapshot.json
```

1~2단계는 현재 Claude Code가 대신 수행한다(로컬에 Node가 없어 자동화 스크립트를 돌릴 수 없기 때문). 매일 자동 갱신이 필요하면 GitHub Actions로 1~3단계를 돌리는 방법이 있다 — 아래 "자동 갱신" 참고.

### GitHub Pages 에 올리기

```powershell
git init
git add .
git commit -m "2차검수 오류 분석 대시보드"
git branch -M main
git remote add origin https://github.com/<계정 또는 조직>/<저장소>.git
git push -u origin main
```

저장소 → **Settings → Pages → Source** 를 `main` 브랜치의 `/docs` 폴더로 지정하면 아래 주소로 열린다.

```
https://<계정>.github.io/<저장소>/dashboard.html
```

### ⚠️ 공개 범위

**GitHub Pages 는 저장소가 private 이어도 페이지 자체는 인터넷에 공개된다**(비공개 Pages는 GitHub Enterprise 기능). 이 대시보드에는 **1차검수자 실명과 개인별 오류 건수**가 들어 있어, 링크를 아는 사람은 누구나 볼 수 있는 상태가 된다. 사내 인원만 보게 하려면 위 표의 B 방식(구글 로그인)을 쓰거나, 이름을 마스킹해야 한다.

### 자동 갱신 (선택)

GitHub Actions 로 매일 자동 갱신할 수 있다. Actions 실행 환경에는 Node가 있으므로 **로컬에 Node를 설치하지 않아도 된다**. 슬랙 토큰은 저장소 Settings → Secrets 에 넣는다. 아직 구성하지 않았다.

## 빠른 시작 (로컬)

1. Node.js 18 이상 설치
2. 슬랙 봇 토큰 준비 (아래 참고), `.env.example` 를 `.env` 로 복사해 값 채우기
3. 의존성 설치 및 실행
   ```bash
   npm install
   npm start
   ```
4. 브라우저에서 http://localhost:3000

## 슬랙 봇 토큰 만들기

1. https://api.slack.com/apps 에서 사내 워크스페이스에 App 생성
2. OAuth & Permissions → Bot Token Scopes 에 추가. **실제로 필요한 건 2개뿐이다**:
   - `channels:history` (공개 채널) 또는 `groups:history` (비공개 채널) — 메시지 읽기
   - `users:read` — 멘션된 1차검수자 이름 조회
   - `channels:read`/`groups:read` 는 **필요 없다**. 이 앱은 `conversations.history` 와 `users.info` 만 호출하고 채널 목록·정보 API는 쓰지 않는다.
3. Install to Workspace → `xoxb-...` 토큰 복사 → `.env` 의 `SLACK_BOT_TOKEN`
4. 슬랙에서 대상 채널에 봇 초대: 채널에서 `/invite @봇이름`

점검: 실행 후 http://localhost:3000/api/health 로 토큰/채널 인식 확인.

### 자주 나는 오류

| 오류 | 원인과 해결 |
|---|---|
| `not_in_channel` | 봇이 채널에 없다. 슬랙에서 대상 채널에 `/invite @봇이름` |
| `missing_scope` | 스코프 부족. 위 2개(`channels:history` 또는 `groups:history`, `users:read`)를 추가하고 앱을 **재설치**해야 반영된다 |
| `invalid_auth` | 토큰이 잘못됨. `.env` 값에 따옴표·공백이 섞이지 않았는지 확인 |
| `channel_not_found` | 채널 ID 오타, 또는 비공개 채널인데 `groups:history` 가 없음 |

## 접근 제어 (구글 로그인 + 이메일 허용목록)

인터넷에 올라가므로 링크만으로는 아무도 볼 수 없게 막혀 있다.

- 로그인하지 않고 페이지에 들어오면 구글 로그인으로 보내고, 로그인한 이메일이 `ALLOWED_EMAILS`(개별) 또는 `ALLOWED_DOMAINS`(도메인 전체)를 통과할 때만 열람이 허용된다. 통과하지 못하면 "열람 권한이 없습니다" 안내가 나온다.
- **사람 추가/삭제는 `ALLOWED_EMAILS` 값만 수정하면 된다.** 코드 수정이 필요 없다. 팀 전체에 열려면 `ALLOWED_DOMAINS=musinsa.com` 으로 넓힐 수 있다(그 도메인 전원이 열람 가능해지므로 신중히).
- 안전장치: 두 목록이 모두 비어 있으면 **아무도** 통과하지 못한다. 구글 설정(`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`SESSION_SECRET`) 중 하나라도 비면 로컬(127.0.0.1) 접속만 열리고 외부 접근은 503으로 차단된다. 설정 실수로 데이터가 공개되지 않도록 잠기는 쪽으로 동작한다.
- 세션은 서명된 쿠키 하나(httpOnly·secure·sameSite=lax)로 유지되며 기본 12시간 후 다시 로그인한다(`SESSION_HOURS`). 우측 상단의 `로그아웃` 또는 `/logout` 으로 로그아웃.
- `/api/health` 만 로그인 없이 열려 있다(배포 상태 점검용, 민감정보 없음).
- 기존 `ACCESS_PASSWORD`(임시 비밀번호)는 이 방식으로 대체되어 제거했다.

`.env`(토큰·시크릿)는 절대 저장소에 올리지 말 것. `.gitignore` 에 이미 들어 있다.

## B. Render 배포 (보류 — 접근 제어가 필요할 때)

아래는 위 표의 B 방식이다. 지금은 A(정적 HTML)로 가기로 해서 **보류 상태**이며, 코드는 이미 완성되어 있다. 열람 권한을 통제해야 할 때 이 절차를 그대로 밟으면 된다.

전제: GitHub 계정, 구글 클라우드 콘솔 접근 권한. 이 PC에 Node.js가 없어도 배포는 가능하다(빌드는 Render가 한다).

**1) GitHub private 저장소에 올리기**

```powershell
git init
git add .
git commit -m "2차검수 오류 분석 웹앱"
git branch -M main
git remote add origin https://github.com/<계정>/<저장소>.git
git push -u origin main
```

저장소는 반드시 **private** 으로 만든다. `.env` 는 `.gitignore` 로 제외되므로 올라가지 않는다.

**2) Render 웹 서비스 만들기**

1. https://render.com 로그인 → **New +** → **Blueprint** → GitHub 저장소 연결 (저장소의 `render.yaml` 을 자동으로 읽는다)
2. 배포 후 주소를 확인한다. 예: `https://second-review-error-dashboard.onrender.com`
3. **Environment** 에서 아래 값을 입력한다. `SESSION_SECRET` 은 Render가 자동 생성하므로 건드리지 않는다.

| 키 | 값 |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-...` (슬랙 봇 토큰) |
| `GOOGLE_CLIENT_ID` | 구글 OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | 구글 OAuth 클라이언트 시크릿 |
| `ALLOWED_EMAILS` | 열람 허용 이메일, 콤마 구분 |
| `ALLOWED_DOMAINS` | (선택) 도메인 전체 허용. 개별 이메일만 쓸 거면 비워둔다 |
| `BASE_URL` | 배포 주소. 예: `https://second-review-error-dashboard.onrender.com` (끝에 `/` 없이) |

**3) 구글 OAuth 클라이언트 발급** (https://console.cloud.google.com)

1. 프로젝트 생성 → **OAuth 동의 화면** 구성 (User Type을 **Internal** 로 하면 회사 계정만 로그인 가능)
2. **사용자 인증 정보** → OAuth 2.0 클라이언트 ID → 애플리케이션 유형 **웹 애플리케이션**
3. **승인된 리디렉션 URI** 에 정확히 이 주소를 등록: `<BASE_URL>/auth/google/callback`
   - 예: `https://second-review-error-dashboard.onrender.com/auth/google/callback`
   - 이 값이 한 글자라도 다르면 `redirect_uri_mismatch` 오류가 난다.
4. 발급된 ID/시크릿을 2)의 Render 환경변수에 넣고 **Save** (자동 재배포된다)

**4) 슬랙 봇 초대**: 슬랙에서 `#카탈로그n세일운영-수정요청` 채널에 `/invite @봇이름`

**5) 확인**

1. `<BASE_URL>/api/health` → `hasToken: true` 인지 확인
2. `<BASE_URL>` 접속 → 구글 로그인 → 대시보드가 뜨는지 확인
3. 허용목록에 없는 계정(개인 gmail 등)으로도 한 번 접속해 **차단되는지** 확인. 이게 가장 중요한 점검이다.

### 알아둘 점

- **무료 플랜은 15분간 접속이 없으면 잠들고, 다음 첫 접속이 40~60초 걸린다.** 팀에 공유했을 때 "안 열린다"는 반응이 나올 수 있다. 상시 응답이 필요하면 Render에서 플랜을 Starter(월 $7)로 올리면 해결된다.
- 슬랙 원문(상품번호·수정사유·검수자 이름)과 봇 토큰이 사내망 밖 Render에 저장된다. 기획서 7번대로 사내 보안정책 확인이 필요한 사안이다.
- 서버 메모리 캐시는 재배포·슬립 후 초기화된다(기능 문제는 없고 첫 조회만 느려진다).

## 화면 사용법

기간을 고르고 조회하면 기획서 4번의 7개 뷰가 모두 나온다.

- **요약 카드**: 총 오류 상품수(일평균 포함), 메시지 수, 무신사/29cm 비중
- **일자별 추이 / 1차검수자별 오류량 / 오류 항목별 빈도**: 막대를 클릭하면 아래 원본 드릴다운이 그 조건으로 필터된다.
- **검수자 × 항목 교차**(기획서 4-6): 행=검수자, 열=오류 항목 히트맵. 색이 진할수록 많다(같은 파랑 계열 6단계).
  - 표시 전환: `건수` / `검수자별 비중(%)`(그 사람이 무엇을 자주 틀리는지) / `항목별 비중(%)`(그 항목을 누가 주로 틀리는지)
  - 기본은 오류량 상위 12명, 옵션에서 20명·전체로 확대
  - 셀 클릭 → 검수자+항목 필터, 행 머리(검수자) 클릭 → 검수자 필터, 열 머리(항목) 클릭 → 항목 필터
- **원본 드릴다운**(기획서 4-7): 필터된 UID와 수정사유 원문 목록. 검수자·항목·플랫폼 선택과 UID/사유 검색을 조합할 수 있고, 열 머리를 클릭하면 정렬, `CSV 내려받기` 는 현재 필터 상태 그대로 내려준다(엑셀용 UTF-8 BOM 포함). 기본 200행씩 표시하고 `더 보기` 로 확장.

정적 모드에서는 상단에 스냅샷 기준 시각 배너가 뜨고 `전체` 버튼이 추가되며, 서버가 없으므로 `새로고침` 은 숨는다. 서버 모드에서만 `새로고침` 이 슬랙에서 다시 읽어오고, 기간별 집계는 기본 60초 캐시된다(`CACHE_TTL_SEC`).

## 검증 상태

이 PC에 Node.js가 없어 서버를 띄우지는 못했다. 대신 아래까지 확인했다.

- **실제 슬랙 데이터로 집계 검증 완료.** 채널에서 405건을 수집해 `server.js` 의 파싱·분류 코드를 그대로 실행 → 오류 상품 1,837건 / 수정요청 메시지 392건 (2026-07-16 ~ 07-31). 무신사 1,578 · 29cm 259.
- **분류 키워드 보강 완료.** `기타` 12.4%(228건) → **0.5%(9건)**. 기존 15개 항목의 우선순위 순서를 유지하고 7개 항목을 추가했으므로 총계와 검수자별 수치는 변하지 않았고 라벨만 세분화되었다. 남은 `기타` 9건은 "재입고 상품입니다", "상세 설명 누락" 2종이다.
- 화면: 실제 데이터가 들어간 `docs/dashboard.html` 을 Chrome 으로 렌더링해 7개 뷰·필터·정렬·CSV·외부요청 0 확인.
- (B방식) 접근 제어: 스텁 환경에서 33개 항목 통과(비로그인 차단, 위조·만료 쿠키 거부, 허용목록 통과/거부, CSRF, fail-closed). 실제 구글 로그인 왕복은 배포 시 첫 검증.

조정이 필요할 때:

- 새로운 유형이 `기타` 로 쌓이면 드릴다운에서 `항목 = 기타` 로 사유 원문을 보고 `server.js` 의 `CATS` 에 키워드를 추가한다.
- (B방식) 30일 조회가 느리면 `CACHE_TTL_SEC` 를 늘린다(예: 300).

## 구조

```
public/index.html     화면 템플릿 (7개 뷰). 정적 모드와 서버 모드를 겸한다
docs/dashboard.html   ★ 산출물: 자체 완결 정적 대시보드 (GitHub Pages 용)
build-dashboard.ps1   조립 스크립트 (템플릿 + Chart.js + 스냅샷 -> 한 개 파일)
snapshot.json         데이터 스냅샷 (수집·집계 결과)
vendor/chart.umd.js   인라인용 Chart.js 원본
server.js             슬랙 수집·파싱·집계 규칙 + (B방식용) API·구글 로그인
render.yaml           (B방식용) Render 배포 설정
기획서.md             기획/규칙 문서
.env / .env.example   슬랙 봇 토큰 등. .env 는 git 에 올라가지 않는다
```

`public/index.html` 은 `window.EMBEDDED` 가 있으면 박혀 있는 데이터로 집계하고(정적 모드), 없으면 `/api/errors` 를 호출한다(서버 모드). 화면 코드는 한 벌만 유지된다.

오류 항목 분류 규칙(`server.js` 의 `CATS`)은 두 방식이 공유한다.

의존성은 `express`, `dotenv` 둘뿐이다. 로그인은 외부 라이브러리 없이 Node 내장 기능으로 구현했다.
