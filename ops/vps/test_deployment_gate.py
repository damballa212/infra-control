"""Local SQLite admission tests. No production database or deployment is touched."""
import importlib.util
from pathlib import Path
import sqlite3
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('deployment_gate', Path(__file__).with_name('deployment-gate.py'))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class DeploymentGateTests(unittest.TestCase):
    def database(self, directory):
        path = Path(directory) / 'infra.sqlite'
        db = sqlite3.connect(path)
        db.executescript('''
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE operations (id TEXT PRIMARY KEY, state TEXT NOT NULL);
        ''')
        db.commit()
        db.close()
        return path

    def test_refuses_active_operation_without_leaving_gate_or_backup(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self.database(directory)
            db = sqlite3.connect(database)
            db.execute("INSERT INTO operations VALUES ('op-1','running')")
            db.commit()
            db.close()
            backup_dir = Path(directory) / 'backups'
            with self.assertRaisesRegex(RuntimeError, '1 operation'):
                gate.enter(database, backup_dir, 60)
            self.assertFalse(backup_dir.exists())
            self.assertIsNone(gate.status(database)['gate'])

    def test_enters_gate_with_consistent_private_backup_and_owner_checked_release(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self.database(directory)
            backup_dir = Path(directory) / 'backups'
            result = gate.enter(database, backup_dir, 60)
            backup = Path(result['backup'])
            self.assertTrue(backup.is_file())
            self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
            self.assertEqual(sqlite3.connect(backup).execute('PRAGMA integrity_check').fetchone()[0], 'ok')
            self.assertEqual(gate.status(database)['gate']['owner'], result['owner'])
            with self.assertRaisesRegex(RuntimeError, 'owner mismatch'):
                gate.release(database, 'wrong-owner')
            self.assertEqual(gate.release(database, result['owner']), {'released': True})
            self.assertIsNone(gate.status(database)['gate'])

    def test_invalid_gate_is_fail_closed_and_expired_gate_can_be_replaced(self):
        with tempfile.TemporaryDirectory() as directory:
            database = self.database(directory)
            db = sqlite3.connect(database)
            db.execute("INSERT INTO settings VALUES ('deployment-gate','not-json')")
            db.commit()
            db.close()
            with self.assertRaisesRegex(RuntimeError, 'already active or invalid'):
                gate.enter(database, Path(directory) / 'backups', 60)
            db = sqlite3.connect(database)
            db.execute("UPDATE settings SET value=? WHERE key='deployment-gate'", ('{"owner":"old","expiresAt":"2000-01-01T00:00:00+00:00"}',))
            db.commit()
            db.close()
            result = gate.enter(database, Path(directory) / 'backups', 60)
            self.assertNotEqual(result['owner'], 'old')
            gate.release(database, result['owner'])


if __name__ == '__main__':
    unittest.main()
