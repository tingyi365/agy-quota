# start-proxy.ps1 — resident launcher for agy-proxy (Anthropic -> Antigravity bridge).
#
# Self-healing while-loop wrapper (mirrors agent/start.ps1): fixed port, restart
# on crash with capped backoff, post-start /health probe, OS-level unbuffered log.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File proxy\start-proxy.ps1
#
# Env overrides: AGY_PROXY_PORT (default 8787), AGY_PROXY_HOST (127.0.0.1),
#                AGY_PROXY_MODEL (claude-opus-4-6-thinking), AGY_PROXY_DEBUG=1.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repo = Split-Path -Parent $here
Set-Location $repo

if (-not $env:AGY_PROXY_PORT) { $env:AGY_PROXY_PORT = '8787' }
if (-not $env:AGY_PROXY_HOST) { $env:AGY_PROXY_HOST = '127.0.0.1' }
$port = [int]$env:AGY_PROXY_PORT
$logFile = Join-Path $here 'agy-proxy.log'

function Test-Port($p) {
    try {
        $c = New-Object System.Net.Sockets.TcpClient
        $iar = $c.BeginConnect('127.0.0.1', $p, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne(200, $false)
        if ($ok) { $c.EndConnect($iar); $c.Close(); return $true }
        $c.Close(); return $false
    } catch { return $false }
}

function Write-WrapLog($msg) {
    $line = "[start-proxy $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
    Write-Host $line
    Add-Content -Path $logFile -Value $line -Encoding utf8
}

# Single-instance guard: never run two proxies on the same port.
if (Test-Port $port) {
    Write-WrapLog "port $port already in use — a proxy is likely already running. Exiting (not double-starting)."
    exit 0
}

Write-WrapLog "starting resident agy-proxy on 127.0.0.1:$port (model=$($env:AGY_PROXY_MODEL))"

# Background /health probe: a few seconds after each (re)start, hit the health
# endpoint once and log liveness + cached-auth readiness. Runs out-of-band so it
# does not block the resident server loop below.
function Start-HealthProbe($p, $lf) {
    Start-Job -ScriptBlock {
        param($port, $logFile)
        Start-Sleep -Seconds 5
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        try {
            $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 5
            $line = "[start-proxy $stamp] /health ok=$($r.ok) auth_ready=$($r.auth_ready) model=$($r.upstream_model)"
        } catch {
            $line = "[start-proxy $stamp] /health UNREACHABLE: $($_.Exception.Message)"
        }
        Add-Content -Path $logFile -Value $line -Encoding utf8
        Write-Host $line
    } -ArgumentList $p, $lf | Out-Null
}

$backoff = 2
$maxBackoff = 60
while ($true) {
    $startTs = Get-Date
    Start-HealthProbe $port $logFile
    # cmd /c redirect = OS-level unbuffered, so a hard crash still flushes the
    # node [agy-proxy] log lines (PowerShell's native 2> buffers and can lose them).
    & cmd /c "node `"$here\server.js`" >> `"$logFile`" 2>&1"
    $code = $LASTEXITCODE
    $ranSec = [int]((Get-Date) - $startTs).TotalSeconds
    Write-WrapLog "server exited code=$code after ${ranSec}s"

    # Reset backoff if it ran healthily for a while; otherwise climb (capped).
    if ($ranSec -ge 30) { $backoff = 2 } else { $backoff = [Math]::Min($backoff * 2, $maxBackoff) }
    Write-WrapLog "restarting in ${backoff}s ..."
    Start-Sleep -Seconds $backoff
}
