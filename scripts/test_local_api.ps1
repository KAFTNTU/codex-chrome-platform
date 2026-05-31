param(
  [string]$BaseUrl = "http://127.0.0.1:17373"
)

$runtimePath = Join-Path $HOME ".chrome-bridge\\runtime.json"
if (-not (Test-Path $runtimePath)) {
  Write-Error "runtime.json not found: $runtimePath"
  exit 1
}

$runtime = Get-Content -Path $runtimePath -Raw | ConvertFrom-Json
$token = $runtime.token
if (-not $token) {
  Write-Error "Token is empty in runtime.json"
  exit 1
}

function Invoke-BridgePost([string]$Path, [hashtable]$Body) {
  $json = $Body | ConvertTo-Json -Depth 12
  Invoke-RestMethod -Method Post -Uri "$BaseUrl$Path" -Headers @{ "X-Bridge-Token" = $token } -ContentType "application/json" -Body $json
}

Write-Host "1) /health"
Invoke-RestMethod -Method Get -Uri "$BaseUrl/health" | ConvertTo-Json -Depth 8 | Write-Host

Write-Host "2) token required check (without token)"
try {
  Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/action" -ContentType "application/json" -Body (@{ action = "extract_tables"; params = @{} } | ConvertTo-Json)
  Write-Host "Expected token error but request succeeded"
} catch {
  Write-Host "Expected error received"
}

Write-Host "3) /api/action extract_tables"
Invoke-BridgePost "/api/action" @{ action = "extract_tables"; params = @{}; token = $token; waitMs = 20000 } | ConvertTo-Json -Depth 12 | Write-Host
