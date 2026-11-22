param(
  [string]$ProjectPath = (Join-Path $PSScriptRoot 'demo'),
  [string]$Task = 'Read math.cjs and math.test.cjs, fix add(), run node --test math.test.cjs, and report the actual result.',
  [string]$ClientFile = (Join-Path $PSScriptRoot '..\quick-proxy\client.local.json')
)
$ErrorActionPreference = 'Stop'
$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$ClientFile = (Resolve-Path -LiteralPath $ClientFile).Path
$sourceDir = Split-Path -Parent $ClientFile
$nodeExe = (Get-Command node -ErrorAction Stop).Source
$stateDir = Join-Path $PSScriptRoot '.local-state'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
function Get-Health([string]$Url) {
  try { return Invoke-RestMethod -Uri $Url -TimeoutSec 2 } catch { return $null }
}
if (-not (Get-Health 'http://127.0.0.1:8787/health')) {
  if (-not (Test-Path -LiteralPath (Join-Path $sourceDir '.env'))) { throw 'Original Quick .env is missing; use the complete original proxy folder.' }
  Start-Process -FilePath $nodeExe -ArgumentList '--env-file=.env','api-server.mjs' -WorkingDirectory $sourceDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'quick.stdout.log') -RedirectStandardError (Join-Path $stateDir 'quick.stderr.log') | Out-Null
}
$oldClient=$env:QUICK_CLIENT_FILE
$oldKey=$env:QUICK_CODEX_KEY
$oldHome=$env:CODEX_HOME
$oldDebug=$env:QUICK_CODEX_DEBUG_ACTIONS
try {
  $env:QUICK_CLIENT_FILE=$ClientFile
  $env:QUICK_CODEX_DEBUG_ACTIONS='0'
  $health=Get-Health 'http://127.0.0.1:8788/health'
  if ($health -and -not $health.experimental) { throw 'Port 8788 is occupied by another service.' }
  if (-not $health) {
    $adapter=Join-Path $PSScriptRoot 'adapter.mjs'
    Start-Process -FilePath $nodeExe -ArgumentList ('"'+$adapter+'"') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stateDir 'bridge.stdout.log') -RedirectStandardError (Join-Path $stateDir 'bridge.stderr.log') | Out-Null
  }
  $ready=$false
  for($i=0;$i -lt 20;$i++) {
    if ((Get-Health 'http://127.0.0.1:8787/health') -and (Get-Health 'http://127.0.0.1:8788/health')) { $ready=$true; break }
    Start-Sleep -Milliseconds 250
  }
  if(-not $ready) { throw 'Local services did not start. Inspect .local-state logs.' }
  $client=Get-Content -LiteralPath $ClientFile -Raw | ConvertFrom-Json
  $env:QUICK_CODEX_KEY=$client.apiKey
  $env:CODEX_HOME=Join-Path $stateDir 'codex-home'
  New-Item -ItemType Directory -Path $env:CODEX_HOME -Force | Out-Null
  $installed=Get-ChildItem -LiteralPath (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin') -Filter codex.exe -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if($installed) { $codexExe=$installed.FullName } else { $codexExe=(Get-Command codex -ErrorAction Stop).Source }
  $options=@('--no-daemon','--disable','multi_agent','-C',$ProjectPath,'-s','workspace-write','-a','on-request',
    '-c','model="quick"','-c','model_provider="quick_local"',
    '-c','model_providers.quick_local.name="Quick experiment"',
    '-c','model_providers.quick_local.base_url="http://127.0.0.1:8788/v1"',
    '-c','model_providers.quick_local.wire_api="responses"',
    '-c','model_providers.quick_local.env_key="QUICK_CODEX_KEY"',
    '-c','model_providers.quick_local.requires_openai_auth=false',
    '-c','model_providers.quick_local.supports_websockets=false',
    '-c','model_providers.quick_local.request_max_retries=0',
    '-c','model_providers.quick_local.stream_max_retries=0',
    '-c','web_search="disabled"','-c','windows.sandbox="elevated"',
    '-c','model_context_window=24000',
    '-c','model_auto_compact_token_limit=18000')
  Write-Host 'Experimental Quick coding adapter. Using an isolated Codex home; existing CC Switch settings are unchanged.'
  & $codexExe @options $Task
} finally {
  $env:QUICK_CLIENT_FILE=$oldClient
  $env:QUICK_CODEX_KEY=$oldKey
  $env:CODEX_HOME=$oldHome
  $env:QUICK_CODEX_DEBUG_ACTIONS=$oldDebug
}
