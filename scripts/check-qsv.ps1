<#
.SYNOPSIS
  Checks whether Intel Quick Sync (QSV) works on this Windows machine.

.DESCRIPTION
  Run on the N100 itself, from the repo root:
    powershell -ExecutionPolicy Bypass -File .\scripts\check-qsv.ps1

  Needs FFmpeg on PATH (winget install Gyan.FFmpeg), or pass -Ffmpeg <path>.
  Writes the full FFmpeg output to qsv-check.log for troubleshooting.
  Works in Windows PowerShell 5.1 and PowerShell 7.
#>
param(
  [string]$Ffmpeg = 'ffmpeg',
  [string]$LogFile = (Join-Path (Get-Location) 'qsv-check.log')
)

$ErrorActionPreference = 'Continue'
$script:ok = 0
$script:fail = 0

function Pass([string]$message) {
  Write-Host "  [OK]   $message" -ForegroundColor Green
  $script:ok++
}

function Fail([string]$message) {
  Write-Host "  [FAIL] $message" -ForegroundColor Red
  $script:fail++
}

function Note([string]$message) {
  Write-Host "  [INFO] $message" -ForegroundColor Yellow
}

# Runs ffmpeg with verbose logging into $LogFile. Returns @{ Ok; Seconds; Errors }.
function Invoke-Ffmpeg([string]$label, [string[]]$ffmpegArgs) {
  $fullArgs = @('-hide_banner', '-nostats', '-loglevel', 'verbose', '-y') + $ffmpegArgs
  $watch = [System.Diagnostics.Stopwatch]::StartNew()
  $output = @(& $script:ffmpegPath @fullArgs 2>&1 | ForEach-Object { "$_" })
  $watch.Stop()
  $exitCode = $LASTEXITCODE

  Add-Content -Path $LogFile -Encoding UTF8 -Value (@(
      '', "### $label (exit code $exitCode)", "ffmpeg $($fullArgs -join ' ')", ''
    ) + $output)

  $errors = @($output | Where-Object {
      $_ -match '(?i)error|invalid|fail|unsupported|not supported|cannot|unable'
    } | Select-Object -Last 6)
  return @{ Ok = ($exitCode -eq 0); Seconds = $watch.Elapsed.TotalSeconds; Errors = $errors }
}

function Show-Errors($result) {
  foreach ($line in $result.Errors) { Write-Host "         $line" -ForegroundColor DarkRed }
}

function Report([string]$label, $result) {
  if ($result.Ok) {
    Pass ('{0} ({1:N1} s, ~{2:N0} fps incl. start-up)' -f $label, $result.Seconds, (150 / $result.Seconds))
  } else {
    Fail $label
    Show-Errors $result
  }
}

Write-Host '== GPU'
$gpus = @(Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue)
$intel = @($gpus | Where-Object { $_.Name -match 'Intel' })
if ($intel.Count -gt 0) {
  foreach ($gpu in $intel) {
    Pass "$($gpu.Name), driver $($gpu.DriverVersion)"
  }
} elseif ($gpus.Count -gt 0) {
  Fail "no Intel GPU found (found: $(($gpus | ForEach-Object { $_.Name }) -join ', '))"
} else {
  Fail 'could not query video controllers (not running on Windows?)'
}

Write-Host ''
Write-Host '== FFmpeg'
$command = Get-Command $Ffmpeg -ErrorAction SilentlyContinue
if (-not $command) {
  Fail "ffmpeg not found. Install it with: winget install Gyan.FFmpeg (then open a new terminal)"
} else {
  $script:ffmpegPath = $command.Source
  Pass ((& $script:ffmpegPath -hide_banner -version | Select-Object -First 1))

  $encoders = (& $script:ffmpegPath -hide_banner -encoders 2>$null) -join "`n"
  foreach ($encoder in @('h264_qsv', 'hevc_qsv')) {
    if ($encoders -match "\b$encoder\b") { Pass "$encoder available in this build" }
    else { Fail "$encoder missing from this FFmpeg build" }
  }

  Write-Host ''
  Write-Host '== QSV tests (5 s of 1080p test video, 150 frames each)'
  Set-Content -Path $LogFile -Encoding UTF8 -Value @(
    "CineVault QSV check, $(Get-Date -Format s)",
    ((& $script:ffmpegPath -hide_banner -version | Select-Object -First 1)),
    (($intel | ForEach-Object { "$($_.Name), driver $($_.DriverVersion)" }) -join '; ')
  )
  $testSource = @('-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '5')
  $sample = Join-Path ([System.IO.Path]::GetTempPath()) 'cinevault-qsv-sample.mkv'
  # Extra encoder options; becomes '-low_power 1' if only the VDENC encoder works.
  $encoderOptions = @()

  # 1. Simplest path: CPU frames in, the encoder uploads them to the GPU itself.
  $label = 'h264_qsv encode (system memory input)'
  $result = Invoke-Ffmpeg $label ($testSource + @('-vf', 'format=nv12', '-c:v', 'h264_qsv', '-f', 'null', '-'))
  if ($result.Ok) {
    Report $label $result
  } else {
    Note "$label failed, retrying with the low-power (VDENC) encoder:"
    Show-Errors $result
    $label = 'h264_qsv encode with -low_power 1'
    $result = Invoke-Ffmpeg $label ($testSource + @('-vf', 'format=nv12', '-c:v', 'h264_qsv', '-low_power', '1', '-f', 'null', '-'))
    Report $label $result
    if ($result.Ok) { $encoderOptions = @('-low_power', '1') }
  }

  # 2. HEVC encode; the file doubles as input for the transcode test.
  $label = 'hevc_qsv encode'
  $result = Invoke-Ffmpeg $label ($testSource + @('-vf', 'format=nv12', '-c:v', 'hevc_qsv') + $encoderOptions + @($sample))
  Report $label $result

  # 3./4. The real-world paths: HEVC file -> QSV decode -> (GPU scale) -> H.264 QSV
  # encode, with frames staying in GPU memory the whole way.
  if ($result.Ok) {
    $decode = @('-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-i', $sample)
    $label = 'HEVC -> H.264 full-GPU transcode'
    $result = Invoke-Ffmpeg $label ($decode + @('-c:v', 'h264_qsv') + $encoderOptions + @('-f', 'null', '-'))
    Report $label $result

    $label = 'HEVC 1080p -> H.264 720p (GPU scaling)'
    $result = Invoke-Ffmpeg $label ($decode + @('-vf', 'scale_qsv=w=1280:h=720', '-c:v', 'h264_qsv') +
      $encoderOptions + @('-f', 'null', '-'))
    Report $label $result
  }
  Remove-Item $sample -ErrorAction SilentlyContinue
  Write-Host ''
  Write-Host "  Full FFmpeg log: $LogFile"
}

Write-Host ''
Write-Host "== Result: $script:ok passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
exit 0
