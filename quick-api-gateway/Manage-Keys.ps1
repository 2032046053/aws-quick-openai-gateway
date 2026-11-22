param(
    [Parameter(Mandatory=$true)][ValidateSet('Create','List','Revoke')][string]$Action,
    [ValidatePattern('^[a-zA-Z0-9_.-]{1,80}$')][string]$Value,
    [string]$SshHost='your-vps'
)
$ErrorActionPreference='Stop'
if ($SshHost.StartsWith('-')) { throw 'Invalid SSH host' }
if ($Action -ne 'List' -and -not $Value) { throw 'Create/Revoke requires -Value' }
$command='quick-key '+$Action.ToLower()
if ($Value) { $command+=' '+$Value }
$result=& ssh -o BatchMode=yes -o ConnectTimeout=10 $SshHost $command
if ($LASTEXITCODE -ne 0) { throw 'Remote key operation failed' }
if ($Action -eq 'Create') {
    $record=($result -join "`n") | ConvertFrom-Json
    if ($record.clientFile -notmatch '^/opt/quick-api/state/clients/[a-f0-9-]+\.json$' -or $record.id -notmatch '^[a-f0-9-]+$') { throw 'Unexpected remote client path' }
    $client=& ssh -o BatchMode=yes -o ConnectTimeout=10 $SshHost ('cat '+$record.clientFile)
    if ($LASTEXITCODE -ne 0) { throw 'Could not retrieve the new client configuration' }
    New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'clients') | Out-Null
    $destination=Join-Path $PSScriptRoot ('clients/'+$record.id+'.json')
    $client -join "`n" | Set-Content -LiteralPath $destination
    Write-Output ('Created '+$record.name+'; key ID '+$record.id+'; client configuration: '+$destination)
} else { Write-Output $result }
