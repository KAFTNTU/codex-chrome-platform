@echo off
setlocal
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%POWERSHELL%" (
  echo PowerShell was not found at "%POWERSHELL%".
  exit /b 1
)
set "EXTENSION_ID=%~1"
if "%EXTENSION_ID%"=="" (
  echo Usage: install-native-host.cmd EXTENSION_ID
  exit /b 1
)
"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-native-host.ps1" -ExtensionId "%EXTENSION_ID%"
