param([ValidateSet('off','windows','cachyos')][string]$Target)
$ErrorActionPreference = 'Stop'
function Announce-Power([string]$EventName) {
 $resume=New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument '-NoProfile -NonInteractive -Command "Start-ScheduledTask -TaskName InfraControlReporter"'
 $trigger=New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(40)
 Register-ScheduledTask -TaskName 'InfraControlReporterResume' -Action $resume -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
 Stop-ScheduledTask -TaskName 'InfraControlReporter' -ErrorAction SilentlyContinue
 try { & C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\InfraControl\reporter.ps1 -Once $EventName | Out-Null } catch {}
}
if ($Target -eq 'off') {
 Announce-Power 'poweroff'
 & C:\Windows\System32\shutdown.exe /s /t 0
 exit $LASTEXITCODE
}
$config = Get-Content C:\ProgramData\InfraControl\boot.json -Raw | ConvertFrom-Json
$id = if ($Target -eq 'windows') { $config.windows } else { $config.cachyos }
if ($id -notmatch '^\{[0-9a-fA-F-]{36}\}$' -and $id -ne '{bootmgr}') { throw 'Invalid fixed boot entry' }
& C:\Windows\System32\bcdedit.exe /set '{fwbootmgr}' bootsequence $id
if ($LASTEXITCODE -ne 0) { throw 'BootNext was not accepted' }
Announce-Power 'reboot'
& C:\Windows\System32\shutdown.exe /r /t 0
exit $LASTEXITCODE
