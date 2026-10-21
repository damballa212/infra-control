# Instala (o retira) el agente de órdenes de la PC en Windows. Ejecutar como Administrador.
#   powershell -ExecutionPolicy Bypass -File .\install-windows-commander.ps1 [-CheckOnly]
#   ... -Caps ping,power   (capacidades; por defecto solo ping: mide la latencia sin ejecutar nada)
#   ... -Remove            (detiene y elimina el agente)
# Junto a este instalador debe estar windows-commander.ps1. No toca boot.json, el BCD, el reporter ni authorized_keys.
param(
  [ValidateSet('ping', 'power')][string[]]$Caps,
  [switch]$CheckOnly,
  [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\InfraControl'
$expectedMac = '02:00:00:00:00:01'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$task = 'InfraControlCommander'

function Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Fail([string]$text) { Write-Host "ERROR: $text" -ForegroundColor Red; exit 1 }

Step 'Comprobando administrador y la PC correcta (MAC)'
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Abre PowerShell como Administrador.' }
$macs = @([System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | ForEach-Object { $raw = $_.GetPhysicalAddress().ToString(); if ($raw.Length -eq 12) { ($raw -replace '(..)(?!$)', '$1:').ToLowerInvariant() } })
if ($macs -notcontains $expectedMac) { Fail 'Esta no es la PC de Infra Control (MAC distinta). No se instaló nada.' }

if ($Remove) {
  Step 'Retirando el agente'
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'InfraControl\\commander\.ps1' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Remove-Item "$root\commander.ps1" -Force -ErrorAction SilentlyContinue
  Write-Host 'Agente retirado. commander.json se conserva por si se vuelve a instalar.' -ForegroundColor Green
  exit 0
}

Step 'Comprobando prerrequisitos'
foreach ($required in @('reporter.json', 'power.ps1')) { if (-not (Test-Path "$root\$required")) { Fail "Falta $required en $root." } }
$weak = (Get-Acl $root).Access | Where-Object { $_.AccessControlType -eq 'Allow' -and $_.IdentityReference.Value -match '(?i)^(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users)$' -and ($_.FileSystemRights.ToString() -match 'Write|Modify|FullControl|CreateFiles|AppendData') }
if ($weak) { Fail "$root permite escribir a usuarios normales; un SYSTEM no debe ejecutar scripts de ahí." }
$source = Join-Path $here 'windows-commander.ps1'
if (-not (Test-Path $source)) { Fail 'Falta windows-commander.ps1 junto a este instalador.' }
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile($source, [ref]$null, [ref]$errors) | Out-Null
if ($errors -and $errors.Count -gt 0) { Fail 'windows-commander.ps1 tiene errores de sintaxis; no se instaló nada.' }
$endpoint = (Get-Content "$root\reporter.json" -Raw | ConvertFrom-Json).endpoint
if (([Uri]$endpoint).Scheme -ne 'https') { Fail 'El endpoint del reporter no es HTTPS.' }
if ($CheckOnly) { Write-Host 'Todo listo para instalar (no se cambió nada).' -ForegroundColor Green; exit 0 }

Step 'Instalando con respaldo'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
if (Test-Path "$root\commander.ps1") { Copy-Item "$root\commander.ps1" "$root\commander.ps1.bak-$stamp" -Force }
$text = [IO.File]::ReadAllText($source, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText("$root\commander.ps1", $text, [Text.UTF8Encoding]::new($true))
if ($Caps -or -not (Test-Path "$root\commander.json")) {
  $chosen = if ($Caps) { @($Caps) } else { @('ping') }
  [IO.File]::WriteAllText("$root\commander.json", (@{ caps = $chosen } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
}
Write-Host "    capacidades: $((Get-Content "$root\commander.json" -Raw | ConvertFrom-Json).caps -join ', ')"

Step 'Registrando la tarea (SYSTEM, al arrancar, igual que el reporter)'
$action = New-ScheduledTaskAction -Execute 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File $root\commander.ps1"
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'InfraControl\\commander\.ps1' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName $task

Step 'Comprobando que el agente quedó en ejecución'
Start-Sleep -Seconds 6
$state = (Get-ScheduledTask -TaskName $task).State
if ($state -ne 'Running') { Fail "La tarea quedó en estado $state. Retírala con -Remove y revisa." }
Write-Host "Listo. Agente en ejecución. El panel debería verlo conectado en unos segundos." -ForegroundColor Green
