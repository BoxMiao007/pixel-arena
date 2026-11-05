# 独立调试实例：与维护者正在用的窗口并行运行，数据目录与 WebView2 profile 都隔离，
# 并单独开一个 CDP 调试端口，供 agent 执行脚本、截图（见 AGENTS.md「调试实例」）。
#
#   pwsh -File scripts/debug-instance.ps1 start    # 起实例（顺带把窗口挪到右下角、不激活）
#   pwsh -File scripts/debug-instance.ps1 stop     # 关实例（只关调试实例，不动维护者的窗口）
#   pwsh -File scripts/debug-instance.ps1 status   # 看状态
#   pwsh -File scripts/debug-instance.ps1 reset    # 关实例并清空调试档案（数据 + 截图）
#
# 依赖：debug 构建 target/debug/pixel-arena.exe（cargo build -p pixel-arena），
# 以及正在跑的 vite dev server（http://localhost:5173；debug 构建从它加载前端）。
param(
  [ValidateSet("start", "stop", "status", "reset")]
  [string]$Action = "start",
  [int]$Port = 0,
  [int]$Width = 1180,
  [int]$Height = 760
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $repo "target\debug\pixel-arena.exe"
$profile = Join-Path $repo ".tmp\debug-profile"
$dataDir = Join-Path $profile "data"
$webviewDir = Join-Path $dataDir "webview"
$pidFile = Join-Path $profile "instance.json"
$shotsDir = Join-Path $repo ".tmp\debug-shots"
if ($Port -le 0) {
  $envPort = $env:PIXEL_ARENA_DEBUG_PORT
  $Port = if ($envPort) { [int]$envPort } else { 9223 }
}

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class PaDebugWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int h2, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  // SPI_GETWORKAREA = 0x30：取主屏工作区（不含任务栏）
  [DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint act, uint param, out RECT r, uint winIni);
}
"@
[void][PaDebugWin]::SetProcessDPIAware()

function Get-DebugProcess {
  if (-not (Test-Path $pidFile)) { return $null }
  $info = Get-Content $pidFile -Raw | ConvertFrom-Json
  $proc = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
  if (-not $proc) { return $null }
  # 只认本仓库的 debug 构建，避免 pid 复用误杀别的进程
  try { $procPath = (Get-Process -Id $proc.Id).Path } catch { return $null }
  if ($procPath -ne $exe) { return $null }
  return $proc
}

function Get-OtherAppWindow {
  Get-Process pixel-arena -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and (Get-Process -Id $_.Id).Path -eq $exe } |
    Where-Object { -not (Test-Path $pidFile) -or $_.Id -ne (Get-Content $pidFile -Raw | ConvertFrom-Json).pid } |
    Select-Object -First 1
}

function Test-Cdp {
  try {
    $null = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 2
    return $true
  } catch { return $false }
}

function Set-WindowPlacement([IntPtr]$handle) {
  $area = New-Object PaDebugWin+RECT
  [void][PaDebugWin]::SystemParametersInfo(0x30, 0, [ref]$area, 0)
  $w = [Math]::Min($Width, $area.Right - $area.Left)
  $h = [Math]::Min($Height, $area.Bottom - $area.Top)
  $x = $area.Right - $w - 16
  $y = $area.Bottom - $h - 16
  # SWP_NOZORDER | SWP_NOACTIVATE：只挪位置和大小，不提层级、不抢焦点
  [void][PaDebugWin]::SetWindowPos($handle, [IntPtr]::Zero, $x, $y, $w, $h, 0x0004 -bor 0x0010)
}

function Stop-DebugInstance {
  $proc = Get-DebugProcess
  if ($proc) {
    Stop-Process -Id $proc.Id -Force
    Wait-Process -Id $proc.Id -Timeout 10 -ErrorAction SilentlyContinue
    Write-Output "已关闭调试实例（pid $($proc.Id)）"
  } else {
    Write-Output "没有在跑的调试实例"
  }
  if (Test-Path $pidFile) { Remove-Item $pidFile -Force }
}

switch ($Action) {
  "start" {
    if (-not (Test-Path $exe)) {
      throw "找不到 $exe，先构建：cargo build -p pixel-arena"
    }
    if (Get-DebugProcess) {
      throw "调试实例已在运行（pid $((Get-DebugProcess).Id)）；先跑 stop，或直接用 status 查看"
    }
    if (Test-Cdp) {
      throw "端口 $Port 已被别的程序占用（可能上一个实例没退出）；换端口或用 -Port 指定"
    }
    $vite = Get-NetTCPConnection -LocalPort 5173 -State Listen -ErrorAction SilentlyContinue
    if (-not $vite) {
      Write-Warning "vite dev server（5173）没在跑，debug 构建会加载不出界面：npm run dev"
    }

    New-Item -ItemType Directory -Force -Path $dataDir, $shotsDir | Out-Null
    $oldData = $env:PIXEL_ARENA_DATA_DIR
    $oldArgs = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    try {
      $env:PIXEL_ARENA_DATA_DIR = $dataDir
      # 只给调试实例开 CDP；维护者的窗口永远不带这个参数
      $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$Port"
      $proc = Start-Process -FilePath $exe -WorkingDirectory $repo -PassThru
    } finally {
      $env:PIXEL_ARENA_DATA_DIR = $oldData
      $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldArgs
    }

    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline -and -not (Test-Cdp)) {
      if ($proc.HasExited) { throw "调试实例启动后退出了（exit $($proc.ExitCode)）" }
      Start-Sleep -Milliseconds 300
    }
    if (-not (Test-Cdp)) {
      throw "等了 30 秒 CDP 端口 $Port 还没起来；看窗口是否报错（数据目录：$dataDir）"
    }

    $proc.Refresh()
    $handle = [IntPtr]::Zero
    for ($i = 0; $i -lt 60 -and $handle -eq [IntPtr]::Zero; $i++) {
      $proc.Refresh()
      if ($proc.MainWindowHandle -ne 0) { $handle = $proc.MainWindowHandle; break }
      Start-Sleep -Milliseconds 200
    }
    if ($handle -ne [IntPtr]::Zero) { Set-WindowPlacement $handle }
    # 新窗口可能抢走了焦点：把前台还给维护者原来那个窗口（失败就保持现状）
    $other = Get-OtherAppWindow
    if ($other) {
      try { [void][PaDebugWin]::SetForegroundWindow($other.MainWindowHandle) } catch { }
    }

    @{ pid = $proc.Id; port = $Port; startedAt = (Get-Date).ToString("s"); dataDir = $dataDir } |
      ConvertTo-Json | Set-Content -Path $pidFile -Encoding UTF8

    Write-Output "调试实例已启动"
    Write-Output "  pid       : $($proc.Id)"
    Write-Output "  cdp       : http://127.0.0.1:$Port"
    Write-Output "  数据目录  : $dataDir"
    Write-Output "  WebView2  : $webviewDir"
    Write-Output "  用法      : node scripts/debug-cdp.mjs shot demo.png"
  }
  "stop" { Stop-DebugInstance }
  "reset" {
    Stop-DebugInstance
    if (Test-Path $profile) { Remove-Item $profile -Recurse -Force }
    if (Test-Path $shotsDir) { Remove-Item $shotsDir -Recurse -Force }
    Write-Output "调试档案已清空"
  }
  "status" {
    $proc = Get-DebugProcess
    $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    Write-Output ("实例进程 : " + $(if ($proc) { "运行中（pid $($proc.Id)）" } else { "未运行" }))
    Write-Output ("CDP 端口 : $Port " + $(if ($listening) { "在监听" } else { "未监听" }) + " / 探测 " + $(if (Test-Cdp) { "通" } else { "不通" }))
    Write-Output ("数据目录 : $dataDir " + $(if (Test-Path $dataDir) { "存在" } else { "未创建" }))
    Write-Output ("WebView2 : $webviewDir " + $(if (Test-Path $webviewDir) { "存在" } else { "未创建" }))
    Write-Output ("截图目录 : $shotsDir " + $(if (Test-Path $shotsDir) { "存在" } else { "未创建" }))
  }
}
