# 정적 대시보드 조립 스크립트 (Node 불필요)
#
#   public/index.html  +  Chart.js(인라인)  +  데이터 스냅샷(인라인)  =  docs/dashboard.html
#
# 결과물은 외부 요청이 0인 자체 완결 HTML 한 개 파일이며, GitHub Pages 에 그대로 올릴 수 있다.
# 데이터 스냅샷(-DataPath)은 슬랙에서 수집·집계한 JSON 이다. ({ from, to, drill:[...] } 형태)
#
# 사용법:
#   powershell -ExecutionPolicy Bypass -File build-dashboard.ps1 -DataPath .\snapshot.json
param(
  [Parameter(Mandatory = $true)][string]$DataPath,
  [string]$OutPath = "docs\dashboard.html",
  [string]$Title = "2차검수 오류 분석"
)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$tpl = Join-Path $root "public\index.html"
$vendor = Join-Path $root "vendor\chart.umd.js"
$out = if ([IO.Path]::IsPathRooted($OutPath)) { $OutPath } else { Join-Path $root $OutPath }

foreach ($p in @($tpl, $vendor, $DataPath)) {
  if (-not (Test-Path $p)) { throw "파일을 찾을 수 없습니다: $p" }
}

$html = [IO.File]::ReadAllText($tpl)
$chart = [IO.File]::ReadAllText($vendor)
$data = [IO.File]::ReadAllText($DataPath) | ConvertFrom-Json

# 스냅샷 생성 시각을 기록 (화면 상단 배너에 표시된다)
if (-not $data.generatedAt) { $data | Add-Member -NotePropertyName generatedAt -NotePropertyValue (Get-Date).ToString("o") -Force }

# 기간을 실제 데이터가 있는 범위로 좁힌다. (조회 기간 앞부분이 비어 있으면 빈 구간만 길어진다)
if ($data.drill -and $data.drill.Count -gt 0) {
  $dates = $data.drill | ForEach-Object { $_.date } | Sort-Object
  $data.from = $dates[0]
  $data.to = $dates[-1]
}
$json = $data | ConvertTo-Json -Depth 6 -Compress

# 1) Chart.js CDN 태그 -> 인라인 스크립트 + 데이터 주입
$cdnTag = '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.0/dist/chart.umd.js"></script>'
if (-not $html.Contains($cdnTag)) { throw "템플릿에서 Chart.js 태그를 찾지 못했습니다. public/index.html 이 수정되었는지 확인하세요." }
$inline = "<script>window.EMBEDDED=$json;</script>" + [Environment]::NewLine + "<script>$chart</script>"
$html = $html.Replace($cdnTag, $inline)

# 2) 제목 반영
$html = $html.Replace("<title>2차검수 오류 분석</title>", "<title>$Title</title>")

$outDir = Split-Path -Parent $out
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force $outDir | Out-Null }
[IO.File]::WriteAllText($out, $html, (New-Object Text.UTF8Encoding $false))

$rows = if ($data.drill) { $data.drill.Count } else { 0 }
"생성 완료: $out"
"  기간 $($data.from) ~ $($data.to) · 원본 $rows 행 · 크기 $([Math]::Round((Get-Item $out).Length / 1KB)) KB"
"  외부 요청 0 (Chart.js·데이터 모두 인라인)"
