"""One-shot, same-host Betza import. No agents, network, installs or service changes.

Stage first; apply requires its manifest digest. Originals and ignored runtime data
remain untouched. Native Hermes parser and atomic import_sessions handle history.
"""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys

SOURCE=Path('/home/ubuntu/orca/workspaces/citas-betza/axolotl')
DEST=Path('/home/ubuntu/projects/hermes-workspaces/citas-betza')
HOME=Path('/home/ubuntu/.hermes/profiles/dev-hub')
OLD_CWDS={str(SOURCE),'/home/ubuntu/dev-hub/worktrees/betza-citas-ai-first-betza-seguridad-v011'}
HEAD='836216bd1987c3f14040ba4e3897fda91f1a4a7b'
REMOTE='https://github.com/damballa212/citas-betza.git'
MARKER='workspace = "damballa212"\nproject = "vault-betza-citas"\nproject_strategy = "repo-root"\n'


def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()


def git(root,*args):
    return subprocess.check_output(['git','-C',str(root),*args],stderr=subprocess.PIPE)


def bounded_rows(path):
    with Path(path).open('rb') as f:
        while raw:=f.readline(8*1024*1024):
            if not raw.endswith(b'\n') and len(raw)==8*1024*1024:
                m=re.search(rb'"type"\s*:\s*"([^"]+)"',raw[:2048])
                # The native parser ignores these categories entirely.
                ignored=bool(m and m[1] not in (b'session_meta',b'response_item'))
                chunks=None if ignored else bytearray(raw)
                while raw and not raw.endswith(b'\n'):
                    raw=f.readline(1024*1024)
                    if chunks is not None:
                        if len(chunks)+len(raw)>32*1024*1024:raise ValueError('Importable record too large')
                        chunks.extend(raw)
                if ignored:continue
                raw=chunks
            if raw.strip():
                value=json.loads(raw)
                if not isinstance(value,dict):raise ValueError('Unexpected record type')
                yield value


def discover():
    result=[]
    for path in Path('/home/ubuntu/.codex/sessions').rglob('*.jsonl'):
        with path.open() as f:line=f.readline(65536)
        if 'betza' not in line.lower():continue
        data=json.loads(line).get('payload',{})
        if data.get('cwd') in OLD_CWDS:
            result.append(dict(path=str(path),id=data['id'],timestamp=data['timestamp'],cwd=data['cwd'],sha256=digest(path)))
    if len(result)!=10 or len({x['id'] for x in result})!=10:raise ValueError('Expected ten distinct source sessions')
    return sorted(result,key=lambda x:x['timestamp'])


def inventory():
    if git(SOURCE,'rev-parse','HEAD').decode().strip()!=HEAD:raise ValueError('Source HEAD changed')
    names=git(SOURCE,'ls-files','--cached','--others','--exclude-standard','-z').decode().split('\0')
    files=[]
    for name in sorted(set(x for x in names if x)):
        rel=Path(name)
        if rel.is_absolute() or '..' in rel.parts or rel.parts[0]=='.git':raise ValueError('Unsafe source path')
        path=SOURCE/rel
        if path.is_symlink() or any(SOURCE.joinpath(*rel.parts[:n]).is_symlink() for n in range(len(rel.parts))):raise ValueError('Unexpected source symlink')
        if not path.exists():files.append(dict(path=name,deleted=True));continue
        if not stat.S_ISREG(path.stat().st_mode):raise ValueError('Only regular source files are copied')
        files.append(dict(path=name,sha256=digest(path),mode=stat.S_IMODE(path.stat().st_mode)))
    return dict(head=HEAD,status=git(SOURCE,'status','--porcelain=v1','-z').hex(),files=files)



def json_digest(data):
    return hashlib.sha256(json.dumps(data,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()).hexdigest()


def workspace_snapshot(root):
    root=Path(root);files=[];directories=[]
    if not (root/'.git').is_dir() or (root/'.git').is_symlink():raise ValueError('Independent Git directory required')
    for parent,dirs,names in os.walk(root):
        parent=Path(parent)
        if parent==root:dirs[:]=[d for d in dirs if d!='.git']
        for name in dirs:
            path=parent/name
            if path.is_symlink():raise ValueError('Unexpected prepared directory symlink')
            directories.append(dict(path=str(path.relative_to(root)),mode=stat.S_IMODE(path.stat().st_mode)))
        for name in names:
            path=parent/name
            if path.is_symlink() or not path.is_file():raise ValueError('Unexpected prepared file type')
            files.append(dict(path=str(path.relative_to(root)),sha256=digest(path),mode=stat.S_IMODE(path.stat().st_mode)))
    return dict(head=git(root,'rev-parse','HEAD').decode().strip(),status=git(root,'status','--porcelain=v1','-z').hex(),
                origin=git(root,'remote','get-url','origin').decode().strip(),
                files=sorted(files,key=lambda x:x['path']),directories=sorted(directories,key=lambda x:x['path']))


def check_budget():
    group=next(line.split(':',2)[2] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
    root=Path('/sys/fs/cgroup')/group.lstrip('/')
    if int((root/'memory.max').read_text())>384*1024*1024 or int((root/'memory.swap.max').read_text())!=0:raise ValueError('Memory budget not enforced')
    quota,period=(root/'cpu.max').read_text().split()
    if quota=='max' or int(quota)/int(period)>0.5:raise ValueError('CPU budget not enforced')


def save(path,data):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False,indent=2));tmp.chmod(0o600);tmp.replace(path)


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('stage',type=Path)
    parser.add_argument('--apply',action='store_true');parser.add_argument('--expected-manifest')
    args=parser.parse_args();stage=args.stage.resolve()
    if stage.parent!=Path('/home/ubuntu/Backups') or not stage.name.startswith('betza-hermes-'):raise ValueError('Private stage required')
    check_budget()
    os.umask(0o077);stage.mkdir(mode=0o700,exist_ok=True)
    os.environ['HERMES_HOME']=str(HOME);sys.path.insert(0,'/home/ubuntu/.hermes/hermes-agent')
    import hermes_bootstrap  # noqa: F401
    from hermes_state import SessionDB
    from hermes_cli import foreign_sessions as foreign
    from agent.redact import redact_sensitive_text
    manifest_path=stage/'manifest.json'
    if not args.apply:
        if manifest_path.exists():raise ValueError('Use a fresh stage; never overwrite evidence')
        source=inventory();sessions=discover();workspace=stage/'workspace'
        subprocess.run(['git','clone','--no-hardlinks','--branch','axolotl',str(SOURCE),str(workspace)],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
        for item in source['files']:
            target=workspace/item['path']
            if item.get('deleted'):
                if target.exists():target.unlink()
            else:
                target.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(SOURCE/item['path'],target)
                if digest(target)!=item['sha256']:raise ValueError('Workspace copy changed')
        if git(workspace,'status','--porcelain=v1','-z').hex()!=source['status']:raise ValueError('Dirty work was not preserved exactly')
        git(workspace,'remote','set-url','origin',REMOTE)
        marker=workspace/'.ai-memory.toml'
        if marker.exists() and marker.read_text()!=MARKER:raise ValueError('Existing memory scope must be reviewed')
        marker.write_text(MARKER)
        staged=SessionDB(db_path=stage/'sessions.sqlite')
        previous=foreign._read_json_lines;foreign._read_json_lines=bounded_rows
        try:
            for item in sessions:
                parsed=foreign.parse_codex_session(Path(item['path']))
                turns=[dict(role=t['role'],content=redact_sensitive_text(t['content'],force=True)) for t in parsed['turns']]
                if not turns:raise ValueError('Source has no conversation')
                sid='betza-'+item['id'];stamp=datetime.fromisoformat(item['timestamp'].replace('Z','+00:00')).timestamp()
                title=next((t['content'].splitlines()[0] for t in turns if t['role']=='user' and t['content'].strip()),'Conversación')
                title='Betza · '+item['timestamp'][:10]+' · '+title[:65]+' · '+item['id'][-6:]
                payload=dict(id=sid,source='codex-cli',cwd=str(DEST),git_branch='axolotl',git_repo_root=str(DEST),title=title,
                             started_at=stamp,ended_at=stamp,end_reason='imported',messages=turns)
                result=staged.import_sessions([payload])
                if not result.get('ok') or result.get('imported')!=1:raise ValueError('Native staging import refused')
                actual=staged.export_session(sid)
                if [dict(role=m['role'],content=m['content']) for m in actual['messages']]!=turns:raise ValueError('Native projection mismatch')
                if digest(item['path'])!=item['sha256']:raise ValueError('Original changed during import')
                item.update(hermes_id=sid,turns=len(turns),projection_sha256=json_digest(actual))
        finally:
            foreign._read_json_lines=previous;staged.close()
        if inventory()!=source:raise ValueError('Source workspace changed during staging')
        manifest=dict(state='staged',source=source,prepared_workspace=workspace_snapshot(workspace),sessions=sessions,destination=str(DEST),profile=str(HOME),ignored_runtime='Original .local, credentials, dependencies and ignored files remain at source; never copied or started')
        save(manifest_path,manifest)
        print(json.dumps(dict(state='staged',sessions=len(sessions),turns=sum(x['turns'] for x in sessions),files=len(source['files']),manifest_sha256=digest(manifest_path))),flush=True)
        return
    if digest(manifest_path)!=args.expected_manifest:raise ValueError('Stale or missing manifest approval')
    manifest=json.loads(manifest_path.read_text())
    if manifest['state']!='staged' or inventory()!=manifest['source']:raise ValueError('Source changed since staging')
    for item in manifest['sessions']:
        if digest(item['path'])!=item['sha256']:raise ValueError('Source session changed since staging')
    if DEST.exists():raise ValueError('Destination exists; do not overwrite any work')
    workspace=stage/'workspace'
    if workspace_snapshot(workspace)!=manifest['prepared_workspace']:raise ValueError('Staged workspace changed')
    before=set()
    db=SessionDB(db_path=HOME/'state.db');staged=SessionDB(db_path=stage/'sessions.sqlite')
    try:
        with db._lock:
            before={r[0] for r in db._conn.execute('SELECT id FROM sessions')}
        ids={s['hermes_id'] for s in manifest['sessions']}
        if before&ids:raise ValueError('A target session already exists; deliberate reconciliation required')
        # Atomic native import: either all ten histories arrive, or none do.
        payload=[staged.export_session(s['hermes_id']) for s in manifest['sessions']]
        if any(json_digest(p)!=s['projection_sha256'] for p,s in zip(payload,manifest['sessions'])):raise ValueError('Staged session projection changed')
        workspace.rename(DEST)
        result=db.import_sessions(payload)
        if not result.get('ok') or result.get('imported')!=10:raise ValueError('Native final import refused; preserve stage for reconciliation')
        for item in manifest['sessions']:
            sid=item['hermes_id'];expected=staged.export_session(sid);actual=db.export_session(sid)
            if [dict(role=m['role'],content=m['content']) for m in actual['messages']]!=[dict(role=m['role'],content=m['content']) for m in expected['messages']]:raise ValueError('Final message mismatch')
            if any(actual.get(k)!=expected.get(k) for k in ('id','source','cwd','git_branch','git_repo_root','title','started_at','ended_at','end_reason')):raise ValueError('Incorrect final session metadata')
        if inventory()!=manifest['source']:raise ValueError('Original workspace changed')
        manifest.update(state='verified',native_import=result)
        save(manifest_path,manifest)
        print(json.dumps(dict(state='verified',sessions=10,turns=sum(s['turns'] for s in manifest['sessions']),destination=str(DEST))),flush=True)
    finally:staged.close();db.close()


if __name__=='__main__':main()
