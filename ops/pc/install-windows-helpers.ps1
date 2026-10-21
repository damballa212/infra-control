# Instala/actualiza los helpers de Infra Control en Windows (ejecutar como Administrador, una vez).
# Copia command.ps1 y boot-default.ps1 desde esta misma carpeta a C:\ProgramData\InfraControl,
# con respaldo de lo anterior, y comprueba el resultado SIN cambiar el arranque ni reiniciar.
# No toca authorized_keys, boot.json, el BCD, el orden de arranque ni las tareas programadas.
#
# Uso (PowerShell como Administrador, en la carpeta con los tres archivos):
#   powershell -ExecutionPolicy Bypass -File .\install-windows-helpers.ps1
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'

$root = 'C:\ProgramData\InfraControl'
$expectedMac = '02:00:00:00:00:01'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$installs = @(
  @{ Source = 'windows-control.ps1';      Target = 'command.ps1' },
  @{ Source = 'windows-boot-default.ps1'; Target = 'boot-default.ps1' }
)
$ps = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'

function Step([string]$text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Fail([string]$text) { Write-Host "ERROR: $text" -ForegroundColor Red; exit 1 }

Step 'Comprobando permisos de administrador'
$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'Abre PowerShell como Administrador y vuelve a ejecutar.' }

Step 'Comprobando que es la PC correcta (MAC fija)'
$macs = @(Get-NetAdapter -Physical | ForEach-Object { $_.MacAddress.Replace('-', ':').ToLowerInvariant() })
if ($macs -notcontains $expectedMac) { Fail 'Esta no es la PC de Infra Control (la MAC no coincide). No se instaló nada.' }

Step 'Comprobando la carpeta protegida'
if (-not (Test-Path $root)) { Fail "No existe $root. Primero hay que instalar el reporter y el control base." }
foreach ($required in @('boot.json', 'power.ps1')) {
  if (-not (Test-Path (Join-Path $root $required))) { Fail "Falta $required en $root; esta PC no tiene el control base instalado." }
}
$weak = (Get-Acl $root).Access | Where-Object {
  $_.AccessControlType -eq 'Allow' -and
  $_.IdentityReference.Value -match '(?i)^(Everyone|BUILTIN\\Users|NT AUTHORITY\\Authenticated Users)$' -and
  ($_.FileSystemRights.ToString() -match 'Write|Modify|FullControl|CreateFiles|AppendData')
}
if ($weak) { Fail "La carpeta $root permite escribir a usuarios normales; un SYSTEM no debe ejecutar scripts de ahí. Corrige los permisos y repite." }

Step 'Comprobando los archivos nuevos'
foreach ($item in $installs) {
  $path = Join-Path $here $item.Source
  if (-not (Test-Path $path)) { Fail "Falta $($item.Source) junto a este instalador." }
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$null, [ref]$errors) | Out-Null
  if ($errors -and $errors.Count -gt 0) { Fail "$($item.Source) tiene errores de sintaxis; no se instaló nada." }
}
if ($CheckOnly) { Write-Host 'Comprobación terminada: todo listo para instalar (no se cambió nada).' -ForegroundColor Green; exit 0 }

Step 'Instalando con respaldo'
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
foreach ($item in $installs) {
  $target = Join-Path $root $item.Target
  if (Test-Path $target) { Copy-Item $target "$target.bak-$stamp" -Force }
  # BOM UTF-8: Windows PowerShell 5.1 lee los .ps1 sin BOM como ANSI y rompería los acentos de las expresiones regulares.
  $text = [IO.File]::ReadAllText((Join-Path $here $item.Source), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($target, $text, [Text.UTF8Encoding]::new($true))
  Write-Host "    $($item.Target) instalado"
}

Step 'Verificando (solo lectura: no cambia el arranque)'
$boot = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'boot-default.ps1') -Status
if ($LASTEXITCODE -ne 0) { Fail 'boot-default.ps1 -Status falló. Restaura los respaldos *.bak-* si hace falta.' }
Write-Host "    boot-default: $boot"
$env:SSH_ORIGINAL_COMMAND = 'status'
$status = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $root 'command.ps1')
Remove-Item Env:SSH_ORIGINAL_COMMAND -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) { Fail 'command.ps1 status falló. Restaura los respaldos *.bak-* si hace falta.' }
Write-Host "    command status: $status"
$value = $status | ConvertFrom-Json
if ($value.defaultSystem -eq 'unknown') {
  Write-Host 'AVISO: el sistema por defecto salió "unknown". Los helpers están instalados, pero boot.json no coincide con las entradas UEFI actuales; el panel seguirá rechazando el cambio hasta corregirlo. Copia esta salida a Claude.' -ForegroundColor Yellow
} else {
  Write-Host "Listo. Sistema por defecto verificado: $($value.defaultSystem)." -ForegroundColor Green
}
