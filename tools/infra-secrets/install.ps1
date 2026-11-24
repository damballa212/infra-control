# Instala infra-secrets para el usuario actual (Windows) y prepara este equipo.
# Uso: powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Machine "PC Windows" [-Url https://...]
# Imprime el hash del token (el token no sale del equipo) para registrarlo en el panel.
param([Parameter(Mandatory = $true)][string]$Machine, [string]$Url = 'https://panel.example.com')
$ErrorActionPreference = 'Stop'
$python = (Get-Command python -ErrorAction Stop).Source
$dest = Join-Path $env:LOCALAPPDATA 'infra-secrets'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Force (Join-Path $PSScriptRoot 'envfile.py'), (Join-Path $PSScriptRoot 'infra_secrets.py') $dest
$shim = "@echo off`r`n`"$python`" -I `"$dest\infra_secrets.py`" %*`r`n"
$shimPath = Join-Path $dest 'infra-secrets.cmd'
[IO.File]::WriteAllText($shimPath, $shim, [Text.Encoding]::ASCII)
# La carpeta Scripts de Python ya está en el PATH del usuario.
Copy-Item -Force $shimPath (Join-Path (Split-Path $python) 'Scripts\infra-secrets.cmd')
& $python -I (Join-Path $dest 'infra_secrets.py') setup --machine $Machine --url $Url
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
# Solo el usuario actual puede leer la configuración y el token.
$cfg = Join-Path $HOME '.config\infra-secrets'
icacls $cfg /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null
