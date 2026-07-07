param(
  [string]$TargetDir,
  [string]$OutputDir,
  [string]$SummaryFile
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")

if (-not $TargetDir) {
  $TargetDir = Join-Path $RepoRoot "desktop\src-tauri\target"
}
if (-not $OutputDir) {
  $OutputDir = Join-Path $RepoRoot "outputs\windows"
}

function Write-SummaryLine {
  param([string]$Line = "")
  if ($SummaryFile) {
    $Line | Out-File -FilePath $SummaryFile -Append -Encoding utf8
  }
}

function Format-SizeMb {
  param([long]$Bytes)
  return [Math]::Round($Bytes / 1MB, 2)
}

$resolvedTargetDir = Resolve-Path $TargetDir -ErrorAction SilentlyContinue
if (-not $resolvedTargetDir) {
  throw "Tauri target directory was not created: $TargetDir"
}

$targetPath = $resolvedTargetDir.Path
$bundleDir = Join-Path $targetPath "release\bundle"

Write-Host "Scanning Windows bundle artifacts under: $targetPath"
Write-SummaryLine "## OpController Windows Build"
Write-SummaryLine

if (Test-Path $bundleDir) {
  Write-Host "Bundle directory: $bundleDir"
  Get-ChildItem $bundleDir -Directory -Recurse -ErrorAction SilentlyContinue |
    Select-Object FullName |
    Format-Table -AutoSize
} else {
  Write-Host "Bundle directory was not found yet: $bundleDir"
}

$installers = @()
if (Test-Path $bundleDir) {
  $installers += Get-ChildItem (Join-Path $bundleDir "nsis") -Filter "*.exe" -File -ErrorAction SilentlyContinue
  $installers += Get-ChildItem (Join-Path $bundleDir "msi") -Filter "*.msi" -File -ErrorAction SilentlyContinue
}

if (-not $installers.Count) {
  Write-SummaryLine "No Windows installer artifacts were found under ``$bundleDir``."
  Write-SummaryLine
  Write-SummaryLine "### Recent files under target"
  Write-SummaryLine
  Write-SummaryLine "| File | Size | Modified |"
  Write-SummaryLine "| --- | ---: | --- |"

  $recentFiles = Get-ChildItem $targetPath -Recurse -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 80

  foreach ($file in $recentFiles) {
    $size = Format-SizeMb -Bytes $file.Length
    Write-SummaryLine "| ``$($file.FullName)`` | $size MB | $($file.LastWriteTime) |"
  }

  if ($recentFiles.Count) {
    Write-Host "Recent files under target:"
    $recentFiles | Select-Object FullName, Length, LastWriteTime | Format-Table -AutoSize
  }

  throw "No .exe/.msi Windows installer artifacts were found. Check the Tauri build log above."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

Write-SummaryLine "| File | Size |"
Write-SummaryLine "| --- | ---: |"

foreach ($installer in $installers) {
  $size = Format-SizeMb -Bytes $installer.Length
  Write-Host ("Found artifact: {0} ({1} MB)" -f $installer.FullName, $size) -ForegroundColor Green
  Write-SummaryLine "| ``$($installer.FullName)`` | $size MB |"
  Copy-Item $installer.FullName -Destination $OutputDir -Force
}

Write-Host "Copied Windows artifacts to: $OutputDir"
