#!/usr/bin/env python3
"""Install this repository at /opt/quick-api after importing a private session."""
import argparse,json,os,pathlib,pwd,shlex,shutil,subprocess,urllib.parse

parser=argparse.ArgumentParser()
parser.add_argument('--public-base-url',required=True)
args=parser.parse_args()
url=urllib.parse.urlsplit(args.public_base_url)
if url.scheme!='https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path.rstrip('/') not in ['/quick/v1','/v1']:
    raise SystemExit('Use an HTTPS base URL ending in /quick/v1 or /v1')
if os.geteuid()!=0:raise SystemExit('Run with sudo/root')
root=pathlib.Path(__file__).resolve().parents[1]
if root!=pathlib.Path('/opt/quick-api'):raise SystemExit('Install the repository at /opt/quick-api first')
node=shutil.which('node');npm=shutil.which('npm')
if not node or not npm:raise SystemExit('Install official Node.js 22+ and npm first')
version=subprocess.check_output([node,'-p','process.versions.node'],text=True).strip()
if int(version.split('.')[0])<22:raise SystemExit('Node.js 22+ required')
if pathlib.Path(node).resolve().is_relative_to('/root') or pathlib.Path(node).resolve().is_relative_to('/home'):
    raise SystemExit('Node must be available outside user home directories')
for name in ['.env','client.local.json','session.local.json']:
    if not (root/'quick-proxy'/name).is_file():raise SystemExit('Import your private session before installation: missing '+name)
session=json.loads((root/'quick-proxy/session.local.json').read_text())
if session.get('outboundProxy'):raise SystemExit('Remove/adjust your workstation outboundProxy before VPS installation')
subprocess.run([npm,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=root/'quick-proxy',check=True)
try:account=pwd.getpwnam('quick-api')
except KeyError:
    subprocess.run(['useradd','--system','--home-dir',str(root),'--shell','/usr/sbin/nologin','quick-api'],check=True)
    account=pwd.getpwnam('quick-api')
subprocess.run(['chown','-R','root:quick-api',str(root)],check=True)
subprocess.run(['chmod','-R','g+rX,o-rwx',str(root)],check=True)
for name in ['.env','client.local.json','session.local.json']:os.chmod(root/'quick-proxy'/name,0o640)
state=root/'state';state.mkdir(exist_ok=True);os.chown(state,account.pw_uid,account.pw_gid);os.chmod(state,0o750)
keys=state/'keys.local.json'
if not keys.exists():keys.write_text('{"version":1,"keys":[]}')
os.chown(keys,account.pw_uid,account.pw_gid);os.chmod(keys,0o600)
services={
    'quick-backend':('quick-proxy',f'{node} --env-file=.env api-server.mjs',[]),
    'quick-codex':('bridge',f'{node} adapter.mjs',[f'QUICK_CLIENT_FILE={root}/quick-proxy/client.local.json','QUICK_CODEX_DEBUG_ACTIONS=0']),
    'quick-gateway':('quick-api-gateway',f'{node} gateway.mjs',[f'QUICK_CLIENT_FILE={root}/quick-proxy/client.local.json',f'GATEWAY_KEYS_FILE={keys}']),
}
for name,(directory,command,variables) in services.items():
    unit=f'[Unit]\nDescription={name}\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nUser=quick-api\nGroup=quick-api\nWorkingDirectory={root}/{directory}\nExecStart={command}\nRestart=on-failure\nRestartSec=3\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nUMask=0077\nMemoryMax=256M\n'
    unit+=''.join('Environment='+value+'\n' for value in variables)
    unit+='\n[Install]\nWantedBy=multi-user.target\n'
    pathlib.Path('/etc/systemd/system/'+name+'.service').write_text(unit)
wrapper=f'#!/bin/sh\nset -eu\ncd {state}\nexec runuser -u quick-api -- env PUBLIC_BASE_URL={shlex.quote(args.public_base_url.rstrip("/"))} {shlex.quote(node)} {root}/quick-api-gateway/keys.mjs "$@"\n'
pathlib.Path('/usr/local/bin/quick-key').write_text(wrapper);os.chmod('/usr/local/bin/quick-key',0o750)
subprocess.run(['systemctl','daemon-reload'],check=True)
subprocess.run(['systemctl','enable','--now',*(name+'.service' for name in services)],check=True)
print('Services installed. Configure your HTTPS ingress, then run: sudo quick-key create alice')
