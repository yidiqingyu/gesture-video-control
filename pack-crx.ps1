# ============================================================
# pack-crx.ps1 —— 用本机 Chrome / Edge 将扩展打包为 .crx
#
# 用法（在项目目录下执行）：
#   powershell -ExecutionPolicy Bypass -File .\pack-crx.ps1
#
# 输出（默认收在项目下的 dist\ 目录里，.gitignore 已忽略）：
#   dist\gesture-video-control.crx   —— 打包好的扩展（可拖入 chrome://extensions 安装）
#   dist\gesture-video-control.pem   —— 扩展私钥（请妥善保管，切勿提交到 GitHub！）
#
# 说明：
#   1. 不直接打包项目目录：那样会把 .git（完整提交历史）、tests\、memory\（本机工作记录）、
#      各种私钥和产物一起塞进用户的 .crx。脚本先复制出一份"只含运行必需文件"的快照再打包，
#      快照用完即删（它是脚本自己生成的临时副本，不是你的文件）。
#   2. 首次打包会生成新的 .pem 密钥，扩展 ID 由该密钥决定；
#      以后想保持同一个扩展 ID 更新，务必保留 .pem 并再次指定：
#        powershell -ExecutionPolicy Bypass -File .\pack-crx.ps1 -Key .\dist\gesture-video-control.pem
#      丢了 .pem 就换了一个扩展 ID，老用户装新 .crx 会变成两个扩展。
#   3. Chrome 只肯把产物写在扩展目录的「上一级」，所以脚本打包完会把它移进 -OutDir；
#   4. 打包出的 .crx 仅用于“开发者模式”安装（拖拽到扩展管理页），
#      与 Chrome 应用商店的正式签名不是一回事。
# ============================================================

param(
  [string]$Key = "",
  # 产物目录，默认项目下的 dist\
  [string]$OutDir = ""
)

$ErrorActionPreference = 'Stop'
$extDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$name = Split-Path -Leaf $extDir
if ($OutDir -eq '') { $OutDir = Join-Path $extDir 'dist' }
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
$OutDir = (Resolve-Path $OutDir).Path

# ---------- 查找本机 Chrome / Edge ----------
$candidates = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) {
  Write-Host '[错误] 未找到 Chrome 或 Edge。' -ForegroundColor Red
  Write-Host '       也可以手动打包：chrome://extensions → 右上角“开发者模式” → “打包扩展程序” → 选择本目录。' -ForegroundColor Yellow
  exit 1
}

# ---------- 准备"只含运行必需文件"的打包快照 ----------
$stageRoot = Join-Path $OutDir '_stage'
if (Test-Path $stageRoot) { Remove-Item -Recurse -Force $stageRoot }
$stageExt = Join-Path $stageRoot $name
New-Item -ItemType Directory -Force -Path $stageExt | Out-Null

# 这些目录/文件不进 .crx：
#   .git 完整提交历史 · .agents 本机工具目录 · tests 自测 · memory 本机工作记录
#   drafts/trash 草稿与暂存 · dist 产物本身 · node_modules · 打包脚本自己 · 私钥/产物/日志
$excludeDirs = @('.git', '.agents', 'tests', 'memory', 'drafts', 'trash', 'dist', 'node_modules')
$excludeFiles = @('.gitignore', 'AGENTS.md', 'pack-crx.ps1', 'pack-crx.bat', '*.pem', '*.crx', '*.log')

Write-Host "使用浏览器: $browser"
Write-Host "项目目录:   $extDir"
Write-Host '正在准备打包快照（排除 .git / tests / memory 等非运行文件）…'
robocopy $extDir $stageExt /E /XD $excludeDirs /XF $excludeFiles /NFL /NDL /NJH /NJS /NP | Out-Null
# robocopy 的返回码：0~7 都算成功，>=8 才是出错
if ($LASTEXITCODE -ge 8) {
  Write-Host "[失败] 复制打包快照失败（robocopy 返回码 $LASTEXITCODE）" -ForegroundColor Red
  exit 1
}
$files = Get-ChildItem -Recurse -File $stageExt
$sizeMb = [math]::Round((($files | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host ("快照内容:   {0} 个文件，约 {1} MB" -f $files.Count, $sizeMb)

# ---------- 组装参数并执行 ----------
$packArgs = @("--pack-extension=$stageExt")
if ($Key -ne '') {
  $packArgs += "--pack-extension-key=$(Resolve-Path $Key)"
}
$packArgs += '--no-message-box'

Write-Host '正在打包，请稍候…'
& $browser $packArgs

# ---------- 等产物写完 ----------
# 坑：Chrome 是 GUI 程序，PowerShell 不会等它跑完就往下走；打包本身也是异步的，
# 所以不能"发完命令立刻检查文件"，否则会误报失败（实际包已经打好了）。
# 这里轮询等 .crx 出现，并且等它大小稳定（连续两次一样）才算写完。
$srcCrx = Join-Path $stageRoot ($name + '.crx')
$srcPem = Join-Path $stageRoot ($name + '.pem')
$deadline = (Get-Date).AddSeconds(60)
$lastSize = -1
while ((Get-Date) -lt $deadline) {
  if (Test-Path $srcCrx) {
    $size = (Get-Item $srcCrx).Length
    if ($size -gt 0 -and $size -eq $lastSize) { break }
    $lastSize = $size
  }
  Start-Sleep -Milliseconds 500
}

if (-not (Test-Path $srcCrx)) {
  Write-Host '[失败] 60 秒内没有生成 .crx。' -ForegroundColor Red
  Write-Host '       常见原因：① Chrome 正在运行（它会把命令转交给已有窗口，不执行打包）→ 先完全退出 Chrome；' -ForegroundColor Yellow
  Write-Host '                 ② 本目录或上一级目录没有写权限；' -ForegroundColor Yellow
  Write-Host '                 ③ manifest.json 格式有问题。' -ForegroundColor Yellow
  Write-Host "       （未完成的快照留在 $stageRoot，可自行检查）" -ForegroundColor Yellow
  exit 1
}

# ---------- 移进产物目录，清理快照 ----------
$crx = Join-Path $OutDir ($name + '.crx')
$pem = Join-Path $OutDir ($name + '.pem')
Move-Item -Force $srcCrx $crx
if (Test-Path $srcPem) { Move-Item -Force $srcPem $pem }
Remove-Item -Recurse -Force $stageRoot

Write-Host ("打包成功: {0}（{1:N1} MB）" -f $crx, ((Get-Item $crx).Length / 1MB)) -ForegroundColor Green
if (Test-Path $pem) {
  Write-Host "私钥文件: $pem" -ForegroundColor Yellow
  Write-Host '请保密、别提交到 GitHub，并且别丢——再打包时要用它保持同一个扩展 ID：' -ForegroundColor Yellow
  Write-Host "  powershell -ExecutionPolicy Bypass -File .\pack-crx.ps1 -Key `"$pem`"" -ForegroundColor Yellow
}
