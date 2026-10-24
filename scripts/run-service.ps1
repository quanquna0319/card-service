param(
    [string]$ProjectDir = (Split-Path -Parent $PSScriptRoot),
    [int]$Port = 8080
)

$ErrorActionPreference = "Stop"

$server = Join-Path $ProjectDir "server.py"
if (-not (Test-Path -LiteralPath $server)) {
    throw "未找到 server.py：$server"
}

Set-Location -LiteralPath $ProjectDir

while ($true) {
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 启动卡密服务，端口 $Port"
    & python $server
    $code = $LASTEXITCODE
    Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] 服务退出，退出码 $code"
    if ($code -eq 0) {
        # 网页里点了重启，进程以 0 退出，需要立即拉起
        Start-Sleep -Seconds 1
        continue
    }
    Write-Host "非重启退出，5 秒后重试；按 Ctrl+C 终止"
    Start-Sleep -Seconds 5
}
