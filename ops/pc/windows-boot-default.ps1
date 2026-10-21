param(
  [ValidateSet('windows','cachyos')][string]$Target,
  [switch]$Status
)
$ErrorActionPreference = 'Stop'
$bcd = 'C:\Windows\System32\bcdedit.exe'
$root = 'C:\ProgramData\InfraControl'
$configPath = Join-Path $root 'boot.json'
$backupPath = Join-Path $root 'boot-default.bcd'
$manifestPath = Join-Path $root 'boot-default.previous.json'
$config = Get-Content $configPath -Raw | ConvertFrom-Json
$windowsId = [string]$config.windows
$cachyosId = [string]$config.cachyos
foreach ($id in @($windowsId, $cachyosId)) {
  if ($id -notmatch '^(?:\{bootmgr\}|\{[0-9a-fA-F-]{36}\})$') { throw 'Configured firmware entry is invalid.' }
}
if ($windowsId -ieq $cachyosId) { throw 'Configured firmware entries must be distinct.' }

function Read-FirmwareOrder {
  $text = & $bcd /enum '{fwbootmgr}' /v 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Firmware boot order could not be read.' }
  $items = [System.Collections.Generic.List[string]]::new()
  $collect = $false
  foreach ($line in $text) {
    if ($line -match '^\s*(?:displayorder|orden\s+de\s+presentaci[oó]n)\s+(.+?)\s*$') {
      foreach ($match in [regex]::Matches($Matches[1], '\{[^}]+\}')) { $items.Add($match.Value) }
      $collect = $true
      continue
    }
    if ($collect -and $line -match '^\s*(\{[^}]+\})\s*$') { $items.Add($Matches[1]); continue }
    $collect = $false
  }
  if ($items.Count -eq 0 -or @($items | Select-Object -Unique).Count -ne $items.Count) { throw 'Firmware order format is not recognized; no change made.' }
  return [pscustomobject]@{ Items = [string[]]$items.ToArray(); Raw = [string[]]$text }
}

function Read-FirmwareEntries {
  $text = & $bcd /enum firmware /v 2>&1
  if ($LASTEXITCODE -ne 0) { throw 'Firmware entries could not be read.' }
  return [string[]]$text
}

function Read-FirmwareBootSequence([string[]]$text) {
  $items = [System.Collections.Generic.List[string]]::new()
  $collect = $false
  foreach ($line in $text) {
    if ($line -match '^\s*(?:bootsequence|secuencia\s+de\s+arranque)\s+(.+?)\s*$') {
      foreach ($match in [regex]::Matches($Matches[1], '\{[^}]+\}')) { $items.Add($match.Value) }
      $collect = $true
      continue
    }
    if ($collect -and $line -match '^\s*(\{[^}]+\})\s*$') { $items.Add($Matches[1]); continue }
    $collect = $false
  }
  return [string[]]$items.ToArray()
}

function Assert-FirmwareTarget([string]$id, [string]$system, [string[]]$text) {
  $sections = [regex]::Split(($text -join [Environment]::NewLine), '(?:\r?\n){2,}')
  $entry = $sections | Where-Object { $_ -match ('(?im)^\s*(?:identifier|identificador)\s+' + [regex]::Escape($id) + '\s*$') } | Select-Object -First 1
  if (-not $entry) { throw 'Configured firmware entry was not found; no change made.' }
  $pathMatch = [regex]::Match($entry, '(?im)^\s*(?:path|ruta)\s+([^\r\n]+?)\s*$')
  if (-not $pathMatch.Success) { throw 'Firmware entry has no verifiable EFI path; no change made.' }
  $path = $pathMatch.Groups[1].Value.Trim()
  if ($system -eq 'windows' -and $path -ine '\EFI\Microsoft\Boot\bootmgfw.efi') { throw 'Configured Windows entry does not point to Windows Boot Manager; no change made.' }
  if ($system -eq 'cachyos' -and ($path -notmatch '(?i)\\grubx64\.efi$' -or $path -match '(?i)installer')) { throw 'Configured CachyOS entry is not the installed GRUB loader; no change made.' }
}

$current = Read-FirmwareOrder
$firmwareEntries = Read-FirmwareEntries
$bootSequence = Read-FirmwareBootSequence $current.Raw
$first = $current.Items[0]
$observed = if ($first -ieq $windowsId) { 'windows' } elseif ($first -ieq $cachyosId) { 'cachyos' } else { 'unknown' }
if ($Status) {
  if ($observed -ne 'unknown') {
    try { Assert-FirmwareTarget $(if($observed -eq 'windows'){$windowsId}else{$cachyosId}) $observed $firmwareEntries }
    catch { $observed='unknown' }
  }
  @{ defaultSystem = $observed; verified = ($observed -ne 'unknown'); observedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
  exit 0
}
if (-not $Target) { throw 'A target system is required.' }
$targetId = if ($Target -eq 'windows') { $windowsId } else { $cachyosId }
Assert-FirmwareTarget $targetId $Target $firmwareEntries
if (-not ($current.Items | Where-Object { $_ -ieq $targetId })) { throw 'Target is not currently in firmware display order; no change made.' }
if ($current.Items[0] -ieq $targetId) {
  @{ accepted = $true; applied = $true; defaultSystem = $Target; verified = $true; observedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
  exit 0
}

# Keep a BCD export and an exact NVRAM-order sidecar before the write. The
# current one-time boot sequence is recorded and verified, never cleared.
Remove-Item ($backupPath + '.tmp') -Force -ErrorAction SilentlyContinue
& $bcd /export ($backupPath + '.tmp') | Out-Null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path ($backupPath + '.tmp'))) { throw 'BCD backup failed; no change made.' }
Move-Item ($backupPath + '.tmp') $backupPath -Force
$manifest = [ordered]@{
  capturedAt = [DateTime]::UtcNow.ToString('o')
  displayOrder = $current.Items
  bootSequence = $bootSequence
  target = $Target
}
$manifestTemp = $manifestPath + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
[IO.File]::WriteAllText($manifestTemp, ($manifest | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
Move-Item $manifestTemp $manifestPath -Force

$expectedOrder = @($targetId) + @($current.Items | Where-Object { $_ -ine $targetId })
try {
  & $bcd /set '{fwbootmgr}' displayorder $targetId /addfirst | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Firmware order write failed.' }
  $after = Read-FirmwareOrder
  $afterSequence = Read-FirmwareBootSequence $after.Raw
  if (($after.Items -join '|') -ine ($expectedOrder -join '|')) { throw 'Firmware order verification failed.' }
  if (($afterSequence -join '|') -ine ($bootSequence -join '|')) { throw 'One-time boot sequence changed unexpectedly.' }
  $readBackDefault = if ($after.Items[0] -ieq $windowsId) { 'windows' } elseif ($after.Items[0] -ieq $cachyosId) { 'cachyos' } else { 'unknown' }
  if ($readBackDefault -ne $Target) { throw 'Firmware default could not be verified.' }
} catch {
  $rollbackFailed = $false
  for ($index = $current.Items.Count - 1; $index -ge 0; $index--) {
    & $bcd /set '{fwbootmgr}' displayorder $current.Items[$index] /addfirst | Out-Null
    if ($LASTEXITCODE -ne 0) { $rollbackFailed = $true }
  }
  if ($rollbackFailed) { throw 'Boot default could not be verified and automatic order restoration failed; the protected BCD and NVRAM backups were retained.' }
  throw 'Boot default was not verified; the previous firmware order was restored. No reboot was requested.'
}

@{ accepted = $true; applied = $true; defaultSystem = $readBackDefault; verified = $true; observedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
