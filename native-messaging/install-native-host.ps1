param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$ExtensionId = '',
  [ValidateSet('chrome', 'edge', 'chromium')]
  [string]$Browser = 'chrome'
)

$ErrorActionPreference = 'Stop'

if (-not $ExtensionId) {
  $ExtensionId = Read-Host 'Extension ID'
}

if (-not $ExtensionId) {
  throw 'Extension ID is required.'
}

$templatePath = Join-Path $PSScriptRoot 'com.codex.bridge.template.json'
$localManifestDir = Join-Path $env:USERPROFILE '.chrome-bridge\native-messaging'
$localManifestPath = Join-Path $localManifestDir 'com.codex.bridge.json'
$launcherPath = Join-Path $RepoRoot 'scripts\start-bridge.bat'
switch ($Browser) {
  'edge'     { $browserSubKey = 'Software\Microsoft\Edge\NativeMessagingHosts\com.codex.bridge' }
  'chromium' { $browserSubKey = 'Software\Chromium\NativeMessagingHosts\com.codex.bridge' }
  default    { $browserSubKey = 'Software\Google\Chrome\NativeMessagingHosts\com.codex.bridge' }
}

New-Item -ItemType Directory -Force -Path $localManifestDir | Out-Null
$template = Get-Content -Raw $templatePath
$manifest = $template.Replace('__EXTENSION_ID__', $ExtensionId).Replace('__LAUNCHER_PATH__', ($launcherPath -replace '\\', '\\\\'))
Set-Content -Path $localManifestPath -Value $manifest -Encoding UTF8

$regRoot = [Microsoft.Win32.Registry]::CurrentUser
$key = $regRoot.CreateSubKey($browserSubKey)
if (-not $key) {
  throw "Unable to create registry key: $browserSubKey"
}
$key.SetValue('', $localManifestPath, [Microsoft.Win32.RegistryValueKind]::String)
$key.Close()

Write-Host "Installed native host manifest to $localManifestPath"
Write-Host "Registered HKCU:\$browserSubKey"
