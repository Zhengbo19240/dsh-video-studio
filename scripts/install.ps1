# DSH 视频套件安装脚本（Windows PowerShell）
#
# 用法（在仓库根目录）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
#   powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1 -Profile desktop
#
# 它做三件事：把两个必需插件 + 一个可选预设 link 进指定 profile。
# 不做的事：不写 ~/.dsh 里的数据（动效库/音效库），那一步在 README 第 3 节。

param(
  [string]$Profile = "desktop",
  [switch]$WithPreset = $true
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Write-Host "仓库: $repo"
Write-Host "profile: $Profile"
Write-Host ""

if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
  throw "找不到 dsh 命令。先确认 DeepSeek Harness 已安装并在 PATH 里。"
}

$targets = @(
  @{ Name = 'dsh-video-workbench'; Path = Join-Path $repo 'packages\video-table' },
  @{ Name = 'dsh-video-brief';     Path = Join-Path $repo 'packages\video-brief' }
)
if ($WithPreset) {
  $targets += @{ Name = 'dsh-video-preset'; Path = Join-Path $repo 'packages\video-preset' }
}

foreach ($t in $targets) {
  if (-not (Test-Path $t.Path)) { throw "缺目录: $($t.Path)" }
  Write-Host "→ 安装 $($t.Name)"
  & dsh plugin --profile $Profile add "link:$($t.Path)"
  if ($LASTEXITCODE -ne 0) { throw "$($t.Name) 安装失败（exit $LASTEXITCODE）" }
}

Write-Host ""
Write-Host "插件已装。还差数据这一步（不做的话动效库和音效库是空的）："
Write-Host ""
Write-Host "  动效库：把 packages\motion-lib 复制到 $env:USERPROFILE\.dsh\motion-lib"
Write-Host "          或设环境变量 DSH_MOTION_LIB 指向它"
Write-Host "  音效库：npm run sounds:download   （下载到 $env:USERPROFILE\.dsh\sound-library）"
Write-Host "          或设环境变量 DSH_SOUND_LIB"
Write-Host ""
Write-Host "然后重启 DSH，在对话里说「打开视频工作台」。"
