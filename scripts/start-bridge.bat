@echo off
setlocal
set "ROOT=%~dp0.."
node "%ROOT%\scripts\bridge_native_host.js"
