import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('betza_migration',Path(__file__).with_name('betza.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)

    def test_reader_preserves_supported_records_and_rejects_corruption(self):
        p=self.root/'session.jsonl';data=[dict(type='session_meta',payload={'id':'synthetic'}),dict(type='response_item',payload={'type':'message','role':'user','content':'Hello'})]
        p.write_text('\n'.join(map(json.dumps,data)));self.assertEqual(data,list(m.bounded_rows(p)))
        p.write_text('{bad json}\n')
        with self.assertRaises(ValueError):list(m.bounded_rows(p))

    def test_large_ignored_record_does_not_drop_the_next_message(self):
        p=self.root/'large.jsonl'
        with p.open('w') as f:
            f.write('{"type":"event_msg","payload":{"ignored":"'+'x'*(9*1024*1024)+'"}}\n')
            f.write('{"type":"response_item","payload":{"type":"message","role":"assistant","content":"Kept"}}\n')
        rows=list(m.bounded_rows(p));self.assertEqual(1,len(rows));self.assertEqual('Kept',rows[0]['payload']['content'])

    def test_large_importable_record_is_preserved(self):
        p=self.root/'large.jsonl';record=dict(type='response_item',payload={'type':'message','role':'user','content':'x'*(9*1024*1024)})
        p.write_text(json.dumps(record));self.assertEqual(record,next(m.bounded_rows(p)))

    def repo(self):
        subprocess.run(['git','init','-q',str(self.root)],check=True)
        subprocess.run(['git','-C',str(self.root),'remote','add','origin','https://example.invalid/fixture.git'],check=True)
        (self.root/'tracked.txt').write_text('original');(self.root/'.gitignore').write_text('.local/\n')
        subprocess.run(['git','-C',str(self.root),'add','.'],check=True)
        subprocess.run(['git','-C',str(self.root),'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','fixture'],check=True)
        return m.git(self.root,'rev-parse','HEAD').decode().strip()

    def test_inventory_preserves_dirty_and_untracked_but_excludes_runtime(self):
        head=self.repo();(self.root/'tracked.txt').write_text('modified');(self.root/'new.txt').write_text('untracked')
        (self.root/'.local').mkdir();(self.root/'.local/state').write_text('synthetic private state')
        with patch.object(m,'SOURCE',self.root),patch.object(m,'HEAD',head):result=m.inventory()
        names={x['path'] for x in result['files']};self.assertEqual({'.gitignore','tracked.txt','new.txt'},names)
        self.assertTrue(result['status']);self.assertEqual('modified',(self.root/'tracked.txt').read_text())

    def test_inventory_refuses_symlinks(self):
        head=self.repo();(self.root/'link').symlink_to(self.root/'tracked.txt')
        with patch.object(m,'SOURCE',self.root),patch.object(m,'HEAD',head):
            with self.assertRaises(ValueError):m.inventory()


class PreparedIntegrityTests(unittest.TestCase):
    setUp=MigrationTests.setUp
    repo=MigrationTests.repo
    def test_snapshot_detects_extra_ignored_file_and_marker_change(self):
        self.repo();(self.root/'.ai-memory.toml').write_text(m.MARKER)
        before=m.workspace_snapshot(self.root)
        (self.root/'.local').mkdir();(self.root/'.local/private').write_text('must detect')
        self.assertNotEqual(before,m.workspace_snapshot(self.root))
        (self.root/'.local/private').unlink();(self.root/'.local').rmdir()
        (self.root/'.ai-memory.toml').write_text('changed scope')
        self.assertNotEqual(before,m.workspace_snapshot(self.root))

    def test_snapshot_detects_permissions(self):
        self.repo();before=m.workspace_snapshot(self.root)
        (self.root/'tracked.txt').chmod(0o700)
        self.assertNotEqual(before,m.workspace_snapshot(self.root))

    def test_projection_digest_binds_messages_and_metadata(self):
        data=dict(id='fixture',cwd='/safe',messages=[dict(role='user',content='original')])
        before=m.json_digest(data);data['messages'][0]['content']='tampered'
        self.assertNotEqual(before,m.json_digest(data));data['messages'][0]['content']='original';data['cwd']='/elsewhere'
        self.assertNotEqual(before,m.json_digest(data))


if __name__=="__main__":unittest.main()
