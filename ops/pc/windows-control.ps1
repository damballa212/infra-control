$ErrorActionPreference = 'Stop'
$command = $env:SSH_ORIGINAL_COMMAND
$expected = '02:00:00:00:00:01'
# .NET en vez de Get-NetAdapter: mismo dato (MAC de los adaptadores) en ~30 ms en lugar de >1 s por cargar el módulo.
$macs = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object { $raw = $_.GetPhysicalAddress().ToString(); if ($raw.Length -eq 12) { ($raw -replace '(..)(?!$)', '$1:').ToLowerInvariant() } })
if ($macs -notcontains $expected) { exit 2 }
if ($command -eq 'status') {
 $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
 $defaultSystem='unknown'
 try {
  $output=& C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\InfraControl\boot-default.ps1 -Status
  if($LASTEXITCODE -eq 0){$value=$output|ConvertFrom-Json;if($value.verified -eq $true -and $value.defaultSystem -in @('windows','cachyos')){$defaultSystem=$value.defaultSystem}}
 } catch {}
 @{ os='windows'; bootId=$boot; mac=$expected; defaultSystem=$defaultSystem } | ConvertTo-Json -Compress
 exit 0
}
if ($command -notin @('off','windows','cachyos','default-windows','default-cachyos')) { exit 64 }
if ($command -in @('default-windows','default-cachyos')) {
 $target = $command.Substring('default-'.Length)
 & C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\InfraControl\boot-default.ps1 -Target $target
 if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
 exit 0
}
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\InfraControl\power.ps1 $command"
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddSeconds(5)
Register-ScheduledTask -TaskName 'InfraControlPower' -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
'{"accepted":true}'
