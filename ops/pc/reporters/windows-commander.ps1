# Agente de órdenes de la PC (Windows). Mantiene una conexión HTTPS SALIENTE en espera hacia el panel y ejecuta
# solo órdenes de una lista cerrada. No abre puertos, no acepta shell ni argumentos libres y no concede lectura.
# Instalar con install-windows-commander.ps1. Capacidades que declara: C:\ProgramData\InfraControl\commander.json.
$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\InfraControl'
$ps = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
# Orden -> capacidad que exige. Solo existen las que el panel puede pedir; cualquier otra se rechaza.
$required = @{ 'ping' = 'ping'; 'off' = 'power'; 'windows' = 'power'; 'cachyos' = 'power' }

$mutex = New-Object System.Threading.Mutex($false, 'Global\InfraControlCommander')
if (-not $mutex.WaitOne(0)) { exit 0 }

function Get-Settings {
  $config = Get-Content "$root\reporter.json" -Raw | ConvertFrom-Json
  if (([Uri]$config.endpoint).Scheme -ne 'https') { throw 'HTTPS required' }
  $caps = @('ping')
  if (Test-Path "$root\commander.json") {
    $declared = Get-Content "$root\commander.json" -Raw | ConvertFrom-Json
    $caps = @($declared.caps | Where-Object { $_ -in @('ping', 'power') })
  }
  [pscustomobject]@{ base = ($config.endpoint -replace '/events$', '/commands'); token = $config.token; caps = $caps }
}

function Send-Ack($settings, [string]$id, [bool]$accepted, [string]$boot) {
  $body = @{ accepted = $accepted; bootId = $boot } | ConvertTo-Json -Compress
  Invoke-RestMethod -Uri "$($settings.base)/$id/ack" -Method Post -Headers @{ Authorization = "Bearer $($settings.token)" } `
    -ContentType 'application/json' -Body $body -TimeoutSec 5 -MaximumRedirection 0 | Out-Null
}

function Invoke-Order([string]$command) {
  switch ($command) {
    'ping' { return }
    # Los mismos scripts de siempre (anuncian al panel, fijan el próximo arranque y apagan/reinician sin /f).
    { $_ -in @('off', 'windows', 'cachyos') } {
      Start-Process -FilePath $ps -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "$root\power.ps1", $command)
    }
  }
}

$boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
$handled = [System.Collections.Generic.HashSet[string]]::new()
$failures = 0
while ($true) {
  try {
    $settings = Get-Settings
    $url = '{0}?wait=25&caps={1}' -f $settings.base, ($settings.caps -join ',')
    $response = Invoke-WebRequest -Uri $url -Headers @{ Authorization = "Bearer $($settings.token)" } -TimeoutSec 35 `
      -UseBasicParsing -MaximumRedirection 0
    $failures = 0
    if ($response.StatusCode -ne 200) { continue }
    $order = $response.Content | ConvertFrom-Json
    $known = $required.ContainsKey([string]$order.command)
    $allowed = $known -and ($settings.caps -contains $required[[string]$order.command])
    $fresh = ([string]$order.id) -match '^[0-9a-f-]{36}$' -and -not $handled.Contains([string]$order.id)
    # La orden solo vale para el arranque en el que se emitió (los ping no llevan bootId).
    $sameBoot = ($order.command -eq 'ping') -or ([string]$order.expectedBootId -eq $boot)
    $accept = $allowed -and $fresh -and $sameBoot
    if (-not $fresh) { continue }
    [void]$handled.Add([string]$order.id)
    # Confirmar ANTES de ejecutar: el apagado corta la conexión y el panel necesita saber que se recibió.
    Send-Ack $settings ([string]$order.id) $accept $boot
    if ($accept) { Invoke-Order ([string]$order.command) }
  } catch {
    $failures++
    Start-Sleep -Seconds ([Math]::Min(30, 2 * $failures))
  }
}
