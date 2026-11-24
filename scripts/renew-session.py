#!/usr/bin/env python3
"""Renew an existing Quick website lease; never follows redirects or performs login."""
import argparse, datetime, fcntl, hashlib, http.cookies, json, os, pathlib, re, subprocess, tempfile, urllib.request, urllib.error

def merge_cookies(current, updates):
    cookies={}
    for part in current.split(';'):
        name,sep,value=part.strip().partition('=')
        if sep:cookies[name]=value
    for line in updates:
        parsed=http.cookies.SimpleCookie();parsed.load(line)
        for name,m in parsed.items():
            if m['max-age']=='0':cookies.pop(name,None)
            else:cookies[name]=m.value
    return '; '.join(k+'='+v for k,v in cookies.items())

def extract_csrf(page):
    # Quick bootstraps a JSON object encoded inside an HTML JS string.
    text=page.replace(chr(92)+chr(34),chr(34)).replace('&quot;',chr(34))
    match=re.search(r'"csrf"\s*:\s*"([^"\s<>]{8,512})"',text)
    if not match:raise ValueError('CSRF missing from authenticated page')
    return match.group(1)

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args):return None

def renew(session_file, node, validator, status_file):
    target=pathlib.Path(session_file);before=target.read_bytes();config=json.loads(before)
    report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'ok':False}
    try:
        account=str(config['accountId'])
        if not re.fullmatch(r'\d{12}',account):raise ValueError('Invalid account')
        request=urllib.request.Request('https://quick.aws.com/sn/account/'+account+'/start',headers={'Cookie':config['cookie'],'User-Agent':'Mozilla/5.0'})
        opener=urllib.request.build_opener(NoRedirect)
        with opener.open(request,timeout=25) as response:
            if response.status!=200:raise ValueError('Unexpected page status')
            page=response.read(4*1024*1024+1)
            if len(page)>4*1024*1024:raise ValueError('Page size limit')
            updated={**config,'cookie':merge_cookies(config['cookie'],response.headers.get_all('Set-Cookie',[])),'csrf':extract_csrf(page.decode())}
        fd,name=tempfile.mkstemp(prefix='.renew-',suffix='.json',dir=str(target.parent));candidate=pathlib.Path(name)
        try:
            with os.fdopen(fd,'w') as stream:json.dump(updated,stream)
            check=subprocess.run([node,validator,str(candidate)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=25)
            if check.returncode:raise ValueError('Renewed WebSocket handshake validation failed')
            if target.read_bytes()!=before:raise ValueError('Session changed concurrently; skipped')
            st=target.stat();os.chmod(candidate,st.st_mode&0o777);os.chown(candidate,st.st_uid,st.st_gid);os.replace(candidate,target)
            report.update(ok=True,cookieChanged=updated['cookie']!=config['cookie'],csrfChanged=updated['csrf']!=config['csrf'],handshakeValidated=True)
        finally:candidate.unlink(missing_ok=True)
    except urllib.error.HTTPError as e:
        report.update(reason='login_required' if e.code in (301,302,303,401,403) else 'upstream_http_error',httpStatus=e.code)
    except Exception as e:report.update(reason=str(e) if isinstance(e,ValueError) else type(e).__name__)
    tmp=pathlib.Path(str(status_file)+'.tmp');tmp.write_text(json.dumps(report)+'\n');os.chmod(tmp,0o600);os.replace(tmp,status_file)
    print(json.dumps(report));return report['ok']

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--session',required=True);parser.add_argument('--node',required=True);parser.add_argument('--validator',required=True);parser.add_argument('--status',required=True);args=parser.parse_args()
    with open(args.status+'.lock','w') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:raise SystemExit(0)
        raise SystemExit(0 if renew(args.session,args.node,args.validator,args.status) else 1)
