# 武将牌库 · 停止脚本
#
# 注意：必须存成「UTF-8 带 BOM」，否则 Windows PowerShell 5.1 会按 ANSI 解码、中文乱码。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = $PSScriptRoot
$port = 3456
$pidFile = Join-Path $root '.data\server.pid'

Write-Host ''
Write-Host '  武将牌库 · 停止服务'
Write-Host '  ────────────────────────────────────────'

function Test-PortUp {
    try {
        Invoke-WebRequest "http://127.0.0.1:$port/api/characters" -UseBasicParsing -TimeoutSec 2 | Out-Null
        return $true
    } catch {
        return $false
    }
}

# ------------------------------------------------------------------
# 定位服务进程
#
# 优先读服务自己登记的 .data\server.pid。
# 千万不要用「命令行里包含某段文字」去全盘匹配 —— 任何命令行里恰好
# 带着这段文本的进程（比如正在执行相关命令的 shell runner）都会被误杀。
# 这里即使拿到 PID，也要二次确认它确实是这个服务。
# ------------------------------------------------------------------
$target = $null

if (Test-Path $pidFile) {
    try {
        $info = Get-Content $pidFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $cand = Get-Process -Id $info.pid -ErrorAction SilentlyContinue
        if ($cand) {
            $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$($info.pid)" -ErrorAction SilentlyContinue
            $cmdline = if ($cim) { $cim.CommandLine } else { '' }
            # 二次校验：命令行里确实有 server.mjs
            if ($cmdline -and $cmdline -like '*server.mjs*') {
                $target = $cand
                Write-Host ("  登记进程   PID {0}（{1} 启动）" -f $info.pid, $info.startedAt)
            } else {
                Write-Host ("  PID 文件里的 {0} 已经不是本服务，忽略。" -f $info.pid) -ForegroundColor DarkGray
            }
        } else {
            Write-Host ("  PID 文件里的 {0} 已不存在，清理掉。" -f $info.pid) -ForegroundColor DarkGray
        }
    } catch {
        Write-Host '  PID 文件读不出来，改用端口探测。' -ForegroundColor DarkGray
    }
}

if (-not $target) {
    if (Test-PortUp) {
        Write-Host ("  端口 {0} 有服务在响应，但没有找到 PID 登记。" -f $port) -ForegroundColor Yellow
        Write-Host '  请到那个服务的窗口里按 Ctrl+C 停止。' -ForegroundColor Yellow
        Write-Host ''
        exit 1
    }
    Write-Host '  没有找到正在运行的 武将牌库 服务。' -ForegroundColor DarkGray
    if (Test-Path $pidFile) { Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
    Write-Host ''
    exit 0
}

Write-Host ("  正在停止   PID {0}" -f $target.Id)
Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 900

# 收尾：等端口真的释放
if (Test-PortUp) {
    Write-Host '  进程已结束，但端口仍有响应，可能还有别的实例。' -ForegroundColor Yellow
} else {
    Write-Host '  已停止。' -ForegroundColor Green
}
Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
Write-Host ''
