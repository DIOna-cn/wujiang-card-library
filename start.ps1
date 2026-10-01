# 武将牌库 · 启动脚本
#
# 注意：这个文件必须存成「UTF-8 带 BOM」。
# Windows PowerShell 5.1 读无 BOM 的 UTF-8 文件会按 ANSI 解码，中文全变乱码。
# 配套的 启动.cmd 则必须保持纯 ASCII —— 原因见那个文件里的注释。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = $PSScriptRoot
$port = 3456

function Test-ServerUp {
    param([int]$Port, [int]$TimeoutSec = 2)
    try {
        $r = Invoke-WebRequest "http://127.0.0.1:$Port/api/characters" -UseBasicParsing -TimeoutSec $TimeoutSec
        return $r.StatusCode -eq 200
    } catch {
        return $false
    }
}

Write-Host ''
Write-Host '  武将牌库' -ForegroundColor Yellow
Write-Host '  ────────────────────────────────────────'

# 检查 Node
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host '  没有找到 Node.js。' -ForegroundColor Red
    Write-Host '  请先安装（装 LTS 版，一路下一步即可）：https://nodejs.org/' -ForegroundColor Red
    Write-Host ''
    Write-Host '  装完后若仍提示找不到，关掉本窗口重新双击 启动.cmd。' -ForegroundColor DarkGray
    Write-Host ''
    exit 1
}

$nodeVer = (& node --version).Trim()
Write-Host ("  Node.js    {0}" -f $nodeVer)

# 服务用到较新的内置模块，太老的 Node 跑不起来，早提示比让它报语法错误好
$major = 0
if ($nodeVer -match '^v(\d+)') { $major = [int]$Matches[1] }
if ($major -lt 18) {
    Write-Host ''
    Write-Host ("  Node.js 版本偏低（{0}），需要 18 以上。" -f $nodeVer) -ForegroundColor Red
    Write-Host '  请到 https://nodejs.org/ 下载 LTS 版覆盖安装。' -ForegroundColor Red
    Write-Host ''
    exit 1
}

# 素材目录：找不到时服务端会打印它实际找了哪些位置
$assets = Resolve-Path (Join-Path $root '..\素材') -ErrorAction SilentlyContinue
if ($assets) {
    Write-Host ("  素材目录   {0}" -f $assets)
} else {
    Write-Host '  素材目录   没找到 ..\素材' -ForegroundColor Yellow
    Write-Host '             「素材」要和「武将牌库」并放在同一个文件夹里。' -ForegroundColor Yellow
}

# 已经在跑就不重复启动
if (Test-ServerUp -Port $port) {
    Write-Host ("  服务状态   已在运行（端口 {0}）" -f $port) -ForegroundColor Green
    Write-Host ''
    Write-Host ("  正在打开浏览器  http://127.0.0.1:{0}/" -f $port)
    Start-Process "http://127.0.0.1:$port/"
    Start-Sleep -Seconds 1
    exit 0
}

Write-Host ("  端口       {0}" -f $port)
Write-Host ''
Write-Host '  正在打开浏览器并启动服务…'
Write-Host ''
Write-Host '  ┌────────────────────────────────────────────────┐'
Write-Host '  │  关掉这个窗口，或者按 Ctrl+C，即可停止服务     │'
Write-Host '  └────────────────────────────────────────────────┘'

# 打开浏览器。
# 不要用 Start-Job —— 在 stdout 被重定向的环境里（比如从别的程序调用本脚本）
# PowerShell 的作业机制会直接报错。Start-Process 没有这个问题，
# 而浏览器自身的启动耗时也足够让服务先起来。
Start-Process "http://127.0.0.1:$port/"

Set-Location $root
& node (Join-Path $root 'server\server.mjs') --port $port
$code = $LASTEXITCODE

Write-Host ''
if ($code -ne 0) {
    # 服务异常退出时，它自己已经把原因打在上面了；这里只提醒往上翻
    Write-Host ("  服务异常退出（代码 {0}）。" -f $code) -ForegroundColor Red
    Write-Host '  原因就在上面几行，往上翻看一下。' -ForegroundColor Yellow
    Write-Host '  最常见的是「素材」和「武将牌库」没有并放在一起。' -ForegroundColor Yellow
} else {
    Write-Host '  服务已停止。' -ForegroundColor Yellow
}
Write-Host ''
