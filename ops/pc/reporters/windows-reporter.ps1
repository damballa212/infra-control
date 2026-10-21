param([ValidateSet('online','heartbeat','poweroff','reboot','stopping')][string]$Once)
$ErrorActionPreference='Stop'
$root='C:\ProgramData\InfraControl'
function Send-Report([string]$EventName) {
 $config=Get-Content "$root\reporter.json" -Raw | ConvertFrom-Json
 if(([Uri]$config.endpoint).Scheme -ne 'https'){throw 'HTTPS required'}
 $boot=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
 $mutex=New-Object System.Threading.Mutex($false,'Global\InfraControlReporter')
 $locked=$false
 try {
  $locked=$mutex.WaitOne(7000)
  if(-not $locked){throw 'Reporter busy'}
  $previous=$null
  $state="$root\report-sequence.json"
  if(Test-Path $state){
   try{$previous=Get-Content $state -Raw|ConvertFrom-Json;if(-not $previous.sequence){throw 'Invalid state'}}
   catch{if(Test-Path "$state.backup"){$previous=Get-Content "$state.backup" -Raw|ConvertFrom-Json;$previous.sequence=[int]$previous.sequence+1}else{throw 'Reporter state invalid'}}
  }
  $sequence=if($previous -and $previous.bootId -eq $boot){[int]$previous.sequence+1}else{1}
  $data=@{bootId=$boot;sequence=$sequence;event=$EventName}|ConvertTo-Json -Compress
  $temporary="$state.$([Guid]::NewGuid().ToString('N')).tmp"
  try {
   [IO.File]::WriteAllText($temporary,$data,[Text.UTF8Encoding]::new($false))
   if(Test-Path $state){[IO.File]::Replace($temporary,$state,"$state.backup")}else{[IO.File]::Move($temporary,$state)}
  } finally {if(Test-Path $temporary){Remove-Item $temporary -Force}}
  Invoke-RestMethod -Uri $config.endpoint -Method Post -Headers @{Authorization="Bearer $($config.token)"} -ContentType 'application/json' -Body $data -TimeoutSec 5 -MaximumRedirection 0 | Out-Null
 } finally {if($locked){$mutex.ReleaseMutex()};$mutex.Dispose()}
}
if($Once){Send-Report $Once;exit 0}
$announced=$false
while($true){
 $cycle=[System.Diagnostics.Stopwatch]::StartNew()
 try{if($announced){Send-Report 'heartbeat'}else{Send-Report 'online'};$announced=$true;$delay=10}
 catch{$delay=if($announced){10}else{3}}
 $remaining=[int][Math]::Max(0,[Math]::Ceiling(($delay*1000)-$cycle.Elapsed.TotalMilliseconds))
 if($remaining -gt 0){Start-Sleep -Milliseconds $remaining}
}
