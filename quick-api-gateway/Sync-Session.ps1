param(
    [Parameter(Mandatory=$true)][string]$HarFile,
    [Parameter(Mandatory=$true)][string]$CookieFile,
    [ValidatePattern('^[a-zA-Z0-9_.@:-]+$')][string]$SshHost='your-vps',
    [switch]$ValidateOnly
)
$ErrorActionPreference='Stop'
if ($SshHost.StartsWith('-')) { throw 'Invalid SSH host' }
$HarFile=(Resolve-Path -LiteralPath $HarFile).Path
$CookieFile=(Resolve-Path -LiteralPath $CookieFile).Path
$state=Join-Path $PSScriptRoot '.local-state'
New-Item -ItemType Directory -Path $state -Force | Out-Null
$uploadName='session-upload-'+[guid]::NewGuid().ToString('N')+'.json'
$candidate=Join-Path $state $uploadName
$builder=@'
const fs=require('node:fs');
const [har,cookies,out]=process.argv.slice(1);
const entries=JSON.parse(fs.readFileSync(har,'utf8')).log.entries;
const entry=entries.findLast(e=>e.request?.url?.includes('/operation/ChatBidirectionalStream'));
if(!entry)throw new Error('No Quick WebSocket in HAR: refresh Quick and send a test message while Network recording is active.');
const u=new URL(entry.request.url),id=u.searchParams.get('awsAccountId'),csrf=u.searchParams.get('mbtc');
if(u.protocol!=='wss:'||u.hostname!=='quick.aws.com'||!/^\d{12}$/.test(id||'')||!u.pathname.startsWith('/sn/account/'+id+'/wsproxy/')||!csrf)throw new Error('Invalid Quick WebSocket/account/CSRF metadata');
const cookie=fs.readFileSync(cookies,'utf8').replace(/^\uFEFF/,'').trim().replace(/^Cookie:\s*/i,'');
if(!cookie||/[\r\n]/.test(cookie)||cookie.length>65536)throw new Error('Cookie must be one complete header value on a single line');
fs.writeFileSync(out,JSON.stringify({accountId:id,cookie,csrf:encodeURIComponent(csrf)}),{mode:0o600});
console.log('Session input parsed. AWS account: '+id+'. No API keys were changed.');
'@
try {
    & node -e $builder $HarFile $CookieFile $candidate
    if ($LASTEXITCODE -ne 0) { throw 'Session parsing failed; VPS unchanged.' }
    if ($ValidateOnly) { Write-Output 'Format validation only: no AWS request and no VPS changes.'; return }
    & scp -q $candidate "${SshHost}:/opt/quick-api/state/$uploadName"
    if ($LASTEXITCODE -ne 0) { throw 'Session upload failed; active VPS session unchanged.' }
    $remote=@'
import pathlib,json,subprocess,os,pwd,shutil,time,urllib.request
root=pathlib.Path('/opt/quick-api')
candidate=root/'state'/'__UPLOAD_NAME__'
target=root/'quick-proxy/session.local.json'
backup=None
services=['quick-backend','quick-codex','quick-gateway']
try:
    data=json.loads(candidate.read_text())
    if set(data)!={'accountId','cookie','csrf'}:raise ValueError('Unexpected session fields')
    os.chown(candidate,0,pwd.getpwnam('quick-api').pw_gid);os.chmod(candidate,0o640)
    # Verify a real Quick response BEFORE replacing the active session.
    validator="""
import fs from 'node:fs';
import {createQuickClient} from 'file:///opt/quick-api/quick-proxy/quick-client.mjs';
const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const client=createQuickClient({...c,timeoutMs:45000});
let answer;
for await(const e of client({messages:[{role:'user',content:'请只回复：SESSION_CHECK_OK'}]}))if(e.type==='done')answer=e.text;
if(answer?.trim()!=='SESSION_CHECK_OK')throw new Error('Quick did not return the expected validation response');
console.log('Real Quick session validation passed.');
"""
    check=subprocess.run(['runuser','-u','quick-api','--',str(root/'runtime/node/bin/node'),'--input-type=module','-e',validator,str(candidate)],capture_output=True,text=True,timeout=65)
    if check.returncode:
        print('New Quick login failed validation; existing session was NOT replaced.')
        raise SystemExit(1)
    print(check.stdout.strip(),flush=True)
    backups=root/'state/session-backups';backups.mkdir(exist_ok=True);os.chmod(backups,0o700)
    backup=backups/('session.'+str(time.time_ns())+'.json');shutil.copy2(target,backup);os.chmod(backup,0o600)
    temp=target.with_name('.session-apply.json');temp.write_text(json.dumps(data))
    os.chown(temp,0,pwd.getpwnam('quick-api').pw_gid);os.chmod(temp,0o640);os.replace(temp,target)
    try:
        subprocess.run(['systemctl','restart',*services],check=True)
        for _ in range(30):
            try:
                with urllib.request.urlopen('http://127.0.0.1:8787/health',timeout=2) as response:
                    if response.status==200:break
            except Exception:time.sleep(0.5)
        else:raise RuntimeError('Backend health check failed')
        if any(subprocess.run(['systemctl','is-active','--quiet',name]).returncode for name in services):raise RuntimeError('A service is inactive')
    except Exception:
        shutil.copy2(backup,target);os.chown(target,0,pwd.getpwnam('quick-api').pw_gid);os.chmod(target,0o640)
        subprocess.run(['systemctl','restart',*services])
        raise RuntimeError('Activation failed; previous session restored')
    print('VPS session updated. Existing public API keys preserved. Response history caches cleared. Backup: '+str(backup))
finally:
    candidate.unlink(missing_ok=True)
'@
    $remote=$remote.Replace('__UPLOAD_NAME__',$uploadName)
    $remote | & ssh -o BatchMode=yes -o ConnectTimeout=10 $SshHost python3 -
    if ($LASTEXITCODE -ne 0) { throw 'VPS session activation failed; read the status above.' }
} finally {
    if (Test-Path -LiteralPath $candidate) { Remove-Item -LiteralPath $candidate }
}
