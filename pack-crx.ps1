# ============================================================
# pack-crx.ps1 —— 用本机 Chrome / Edge 将扩展打包为 .crx
#
# 用法（在项目目录下执行）：
#   powershell -ExecutionPolicy Bypass -File .\pack-crx.ps1
#
# 输出：
#   ..\gesture-video-control.crx   —— 打包好的扩展（可拖入 chrome://extensions 安装）
#   ..\gesture-video-control.pem   —— 扩展私钥（请妥善保管，切勿提交到 GitHub！）
#
# 说明：
#   - 首次打包会生成新的 .pem 密钥，扩展 ID 由该密钥决定；
#   - 以后想保持同一个扩展 ID，请保留 .pem 并再次指定：
#       powershell -ExecutionPolicy Bypass -File .\pack-crx.ps1 -Key .\gesture-video-control.pem
#   - 打包出的 .crx 仅用于“开发者模式”安装（拖拽到扩展管理页），
#     与 Chrome 应用商店的正式签名不是一回事。
# ============================================================

param(
  [string]$Key = ""
)

$ErrorActionPreference = 'Stop'
$extDir = Split-Path -Parent $MyInvocation.MyCommand.Path

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

# ---------- 组装参数并执行 ----------
$packArgs = @("--pack-extension=$extDir")
if ($Key -ne '') {
  $packArgs += "--pack-extension-key=$(Resolve-Path $Key)"
}
$packArgs += '--no-message-box'

Write-Host "使用浏览器: $browser"
Write-Host "扩展目录:   $extDir"
Write-Host '正在打包，请稍候…'
& $browser $packArgs

# ---------- 检查产物 ----------
$parent = Split-Path -Parent $extDir
$name = Split-Path -Leaf $extDir
$crx = Join-Path $parent ($name + '.crx')
$pem = Join-Path $parent ($name + '.pem')

if (Test-Path $crx) {
  Write-Host "打包成功: $crx" -ForegroundColor Green
  Write-Host "私钥文件: $pem（请保密，勿提交到 GitHub）" -ForegroundColor Yellow
} else {
  Write-Host '[失败] 未生成 .crx，请检查扩展目录是否存在语法错误（例如 manifest.json 格式问题）。' -ForegroundColor Red
  exit 1
}
