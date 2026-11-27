# tinyprobe Windows 卸载脚本
# 用法（管理员 PowerShell）: iwr .../uninstall.ps1 | iex  或  .\uninstall.ps1 [-Service tinyprobe]
param([string]$Service = 'tinyprobe')
$ErrorActionPreference = 'Continue'

$task = Get-ScheduledTask -TaskName $Service -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $Service -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $Service -Confirm:$false
  Write-Host "== 计划任务已移除: $Service"
} else { Write-Host "== 未找到计划任务: $Service" }

$bin = "$env:ProgramFiles\tinyprobe\tinyprobe-probe.exe"
Remove-Item -Force $bin -ErrorAction SilentlyContinue
Remove-Item -Force "$bin.new", "$bin.swap.bat" -ErrorAction SilentlyContinue
Write-Host "== 二进制已移除: $bin"
Write-Host "== 卸载完成"
