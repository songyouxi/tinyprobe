# tinyprobe 极密卸载脚本
param([string]$Service = 'CoreDiagSvc')
$ErrorActionPreference = 'Continue'

$task = Get-ScheduledTask -TaskName $Service -ErrorAction SilentlyContinue
$dir = $null
if ($task) {
  $act = (Get-ScheduledTask -TaskName $Service).Actions[0]
  if ($act -and $act.Execute) { $dir = Split-Path $act.Execute -Parent }
  Stop-ScheduledTask -TaskName $Service -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Service -Confirm:$false
  Write-Host "== 计划任务已移除: $Service"
} else { Write-Host "== 未找到计划任务: $Service" }

if ($dir -and $dir -like '*corediag*') {
  Remove-Item -Recurse -Force $dir -ErrorAction SilentlyContinue
  Write-Host "== 已移除: $dir"
} else { Write-Host "== 未解析到隐蔽目录，请手动删除" }
Write-Host "== 卸载完成"
