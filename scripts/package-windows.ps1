param(
  [switch]$SkipPrerequisites,
  [switch]$SkipPlaywrightInstall,
  [switch]$RunTests,
  [switch]$Clean
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..")
$RuntimeDir = Join-Path $RepoRoot "runtime"
$DesktopDir = Join-Path $RepoRoot "desktop"
$OutputLogDir = Join-Path $RepoRoot "outputs\logs"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$LogPath = Join-Path $OutputLogDir "package-windows-$Timestamp.log"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
  param([string]$Message)
  Write-Host "OK  $Message" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Message)
  Write-Host "WARN $Message" -ForegroundColor Yellow
}

function Test-Windows {
  if ($env:OS -ne "Windows_NT") {
    throw "Windows 安装包必须在 Windows 环境构建。当前系统不是 Windows。"
  }
}

function Test-Command {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-CommandChecked {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [string]$WorkingDirectory = $RepoRoot
  )

  Push-Location $WorkingDirectory
  try {
    Write-Host ">> $FilePath $($Arguments -join ' ')" -ForegroundColor DarkGray
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "命令执行失败，退出码 $LASTEXITCODE：$FilePath $($Arguments -join ' ')"
    }
  } finally {
    Pop-Location
  }
}

function Refresh-Path {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $cargoPath = Join-Path $env:USERPROFILE ".cargo\bin"
  $env:Path = @($machinePath, $userPath, $cargoPath, $env:Path) -join ";"
}

function Install-WingetPackage {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$Override = ""
  )

  if (-not (Test-Command "winget")) {
    throw "未找到 winget，无法自动安装 $Name。请先安装 App Installer，或手动安装 README 中的 Windows 依赖。"
  }

  Write-Step "检查 $Name"
  $listArgs = @("list", "--id", $Id, "--exact", "--accept-source-agreements")
  & winget @listArgs | Out-Null
  if ($LASTEXITCODE -eq 0) {
    Write-Ok "$Name 已安装"
    return
  }

  Write-Step "安装 $Name"
  $installArgs = @(
    "install",
    "--id", $Id,
    "--exact",
    "--silent",
    "--accept-package-agreements",
    "--accept-source-agreements"
  )
  if ($Override.Trim()) {
    $installArgs += @("--override", $Override)
  }
  Invoke-CommandChecked -FilePath "winget" -Arguments $installArgs
  Refresh-Path
}

function Ensure-Prerequisites {
  if ($SkipPrerequisites) {
    Write-Warn "已跳过系统依赖安装，仅做本地环境检查。"
    return
  }

  Install-WingetPackage -Id "OpenJS.NodeJS.LTS" -Name "Node.js LTS"
  Install-WingetPackage -Id "Python.Python.3.12" -Name "Python 3.12"
  Install-WingetPackage -Id "Rustlang.Rustup" -Name "Rustup"
  Install-WingetPackage -Id "Microsoft.EdgeWebView2Runtime" -Name "Microsoft Edge WebView2 Runtime"
  Install-WingetPackage `
    -Id "Microsoft.VisualStudio.2022.BuildTools" `
    -Name "Visual Studio 2022 Build Tools" `
    -Override "--quiet --wait --norestart --nocache --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

  Refresh-Path
}

function Ensure-Toolchain {
  Write-Step "检查构建工具链"
  foreach ($command in @("node", "npm", "cargo", "rustup")) {
    if (-not (Test-Command $command)) {
      throw "未找到命令：$command。请重新打开 PowerShell 后再运行，或检查安装是否成功。"
    }
  }
  if (-not (Test-Command "py") -and -not (Test-Command "python")) {
    throw "未找到 Python。请确认 Python 3.12+ 已安装并加入 PATH。"
  }

  Invoke-CommandChecked -FilePath "node" -Arguments @("--version")
  Invoke-CommandChecked -FilePath "npm" -Arguments @("--version")
  Invoke-CommandChecked -FilePath "rustup" -Arguments @("default", "stable")
  Invoke-CommandChecked -FilePath "cargo" -Arguments @("--version")

  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $vcTools = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vcTools) {
      Write-Warn "未检测到 Visual C++ Build Tools 组件。Tauri 编译可能失败，请确认 VS Build Tools 已安装 Desktop development with C++。"
    } else {
      Write-Ok "已检测到 Visual C++ Build Tools"
    }
  } else {
    Write-Warn "未找到 vswhere，跳过 Visual Studio Build Tools 检查。"
  }
}

function Get-VenvPython {
  $venvPython = Join-Path $RuntimeDir ".venv\Scripts\python.exe"
  if (Test-Path $venvPython) {
    return $venvPython
  }
  return $null
}

function New-RuntimeVenv {
  $venvPython = Get-VenvPython
  if ($venvPython) {
    Write-Ok "runtime 虚拟环境已存在：$venvPython"
    return $venvPython
  }

  Write-Step "创建 Python runtime 虚拟环境"
  if (Test-Command "py") {
    Invoke-CommandChecked -FilePath "py" -Arguments @("-3.12", "-m", "venv", ".venv") -WorkingDirectory $RuntimeDir
  } else {
    Invoke-CommandChecked -FilePath "python" -Arguments @("-m", "venv", ".venv") -WorkingDirectory $RuntimeDir
  }

  $venvPython = Get-VenvPython
  if (-not $venvPython) {
    throw "runtime 虚拟环境创建失败：未找到 .venv\Scripts\python.exe"
  }
  return $venvPython
}

function Install-ProjectDependencies {
  Write-Step "安装前端依赖"
  Invoke-CommandChecked -FilePath "npm" -Arguments @("install")

  $venvPython = New-RuntimeVenv
  Write-Step "安装 Python runtime 依赖"
  Invoke-CommandChecked -FilePath $venvPython -Arguments @("-m", "pip", "install", "--upgrade", "pip", "setuptools", "wheel") -WorkingDirectory $RuntimeDir
  Invoke-CommandChecked -FilePath $venvPython -Arguments @("-m", "pip", "install", "-e", ".[dev]") -WorkingDirectory $RuntimeDir

  if ($SkipPlaywrightInstall) {
    Write-Warn "已跳过 Playwright Chromium 安装。"
  } else {
    Write-Step "安装 Playwright Chromium"
    Invoke-CommandChecked -FilePath $venvPython -Arguments @("-m", "playwright", "install", "chromium") -WorkingDirectory $RuntimeDir
  }
}

function Invoke-OptionalTests {
  if (-not $RunTests) {
    Write-Warn "默认不运行测试。如需打包前跑测试，请使用 -RunTests。"
    return
  }

  $venvPython = Get-VenvPython
  if (-not $venvPython) {
    throw "未找到 runtime 虚拟环境，无法运行测试。"
  }

  Write-Step "运行 runtime 测试"
  Invoke-CommandChecked -FilePath $venvPython -Arguments @("-m", "pytest") -WorkingDirectory $RuntimeDir
}

function Clear-BuildOutputs {
  if (-not $Clean) {
    return
  }

  Write-Step "清理旧构建产物"
  $paths = @(
    (Join-Path $RepoRoot "desktop\dist"),
    (Join-Path $RepoRoot "runtime\build"),
    (Join-Path $RepoRoot "runtime\dist"),
    (Join-Path $RepoRoot "desktop\src-tauri\target\release\bundle")
  )
  foreach ($path in $paths) {
    if (Test-Path $path) {
      Remove-Item $path -Recurse -Force
      Write-Ok "已删除 $path"
    }
  }
}

function Build-WindowsPackage {
  Write-Step "构建 Windows 安装包"
  Invoke-CommandChecked -FilePath "npm" -Arguments @("run", "build:win")
}

function Show-BuildArtifacts {
  Write-Step "构建产物"
  $collector = Join-Path $ScriptDir "collect-windows-artifacts.ps1"
  $targetDir = Join-Path $DesktopDir "src-tauri\target"
  $artifactDir = Join-Path $RepoRoot "outputs\windows"
  Invoke-CommandChecked `
    -FilePath "powershell" `
    -Arguments @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", $collector,
      "-TargetDir", $targetDir,
      "-OutputDir", $artifactDir
    )
}

New-Item -ItemType Directory -Force -Path $OutputLogDir | Out-Null
Start-Transcript -Path $LogPath -Force | Out-Null

try {
  Test-Windows
  Write-Step "OpController Windows 一键打包开始"
  Write-Host "仓库目录：$RepoRoot"
  Write-Host "日志文件：$LogPath"

  Ensure-Prerequisites
  Ensure-Toolchain
  Clear-BuildOutputs
  Install-ProjectDependencies
  Invoke-OptionalTests
  Build-WindowsPackage
  Show-BuildArtifacts

  Write-Step "Windows 打包完成"
} finally {
  Stop-Transcript | Out-Null
}
