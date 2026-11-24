import datetime
import json
import os
import subprocess
import sys
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
import collector as c

BOOT = '12345678-1234-4234-8234-123456789012'
ID = 'a' * 64
AT = '2026-11-14T10:00:00.000Z'

def container(identifier=ID):
    return {'id': identifier, 'name': '/worker', 'image': 'worker:1', 'status': 'running', 'healthStatus': None,
            'startedAt': '2026-11-14T09:00:00.000000000Z', 'finishedAt': '0001-01-01T00:00:00Z', 'restartCount': 0,
            'labels': {'com.docker.compose.project': 'data-only', 'com.docker.compose.service': None}}

class IO:
    def __init__(self, ids=None):
        self.ids = [ID] if ids is None else ids
        self.calls = []
        self.ps_calls = 0
        self.changed = False
        self.cpu = 'cpu 100 0 50 800 10 0 0 0 20 0\n'
        self.fs_error = False
    def wall(self):
        return AT
    def monotonic(self):
        return 100.0
    def read(self, path, limit):
        if path.endswith('boot_id'):
            return BOOT
        if path.endswith('machine-id'):
            return 'b' * 32
        if path == '/proc/stat':
            return self.cpu
        if path == '/proc/meminfo':
            return 'MemTotal: 1024 kB\nMemAvailable: 256 kB\n'
        raise AssertionError('unexpected read')
    def statvfs(self, path):
        if self.fs_error:
            raise OSError('private filesystem error')
        return SimpleNamespace(f_blocks=100, f_bfree=25, f_bavail=20, f_frsize=4096)
    def run(self, argv, deadline, limit):
        self.calls.append((argv, deadline, limit))
        if argv[len(c.DOCKER)] == 'ps':
            self.ps_calls += 1
            ids = self.ids + ['f' * 64] if self.changed and self.ps_calls == 2 else self.ids
            return ('\n'.join(ids) + ('\n' if ids else '')).encode()
        batch = argv[argv.index(c.TEMPLATE) + 1:]
        return ('\n'.join(json.dumps(container(identifier)) for identifier in batch) + '\n').encode()

class CollectorTests(unittest.TestCase):
    def test_first_cpu_unknown_and_real_memory_filesystem(self):
        sample, checkpoint = c.collect(IO(), {})
        self.assertIsNone(sample['host']['cpu'])
        self.assertEqual(sample['host']['memory']['availableBytes'], 256 * 1024)
        self.assertEqual(sample['host']['rootfs']['freeBytes'], 25 * 4096)
        self.assertEqual(checkpoint['sequence'], 1)
        self.assertNotIn('b' * 32, json.dumps(sample))

    def test_v1_and_v2_share_the_checkpoint_and_legacy_wire_shape(self):
        writes = []
        def record(directory, name, payload, mode, gid, limit):
            writes.append((name, payload))
        def legacy_read(payload):
            if payload['schemaVersion'] != 1 or any('observedAt' in row for row in payload['docker']['containers']):
                raise ValueError('legacy_schema')
            return payload
        with patch.object(c.os.path, 'lexists', return_value=False), patch.object(c, 'atomic_json', side_effect=record):
            c.publish_once('/fixture', IO(), initialize=True)
        self.assertEqual([name for name, _ in writes], ['initialized.json', 'checkpoint.json', 'snapshot.v2.json', 'snapshot.json'])
        files = dict(writes)
        self.assertEqual(files['checkpoint.json']['sequence'], 1)
        self.assertEqual(legacy_read(files['snapshot.json'])['host'], files['snapshot.v2.json']['host'])
        self.assertEqual(files['snapshot.json']['sequence'], files['snapshot.v2.json']['sequence'])
        with self.assertRaisesRegex(ValueError, '^legacy_schema$'):
            legacy_read(files['snapshot.v2.json'])
        previous_v1 = dict(files['checkpoint.json'], sequence=2)
        writes.clear()
        with patch.object(c.os.path, 'lexists', return_value=True), patch.object(c, 'checkpoint_read', return_value=previous_v1), patch.object(c, 'atomic_json', side_effect=record):
            c.publish_once('/fixture', IO())
        self.assertEqual([name for name, _ in writes], ['checkpoint.json', 'snapshot.v2.json', 'snapshot.json'])
        self.assertEqual(legacy_read(dict(writes)['snapshot.json'])['sequence'], 3)

    def test_missing_checkpoint_never_falls_back_to_first_publication(self):
        with patch.object(c.os, 'open', side_effect=FileNotFoundError), patch.object(c, 'atomic_json') as write:
            with self.assertRaisesRegex(c.CollectionError, '^checkpoint_missing$'):
                c.publish_once('/fixture', IO())
            write.assert_not_called()
        with patch.object(c.os.path, 'lexists', return_value=True), patch.object(c, 'atomic_json') as write:
            with self.assertRaisesRegex(c.CollectionError, '^already_initialized$'):
                c.publish_once('/fixture', IO(), initialize=True)
            write.assert_not_called()

    def test_cpu_delta_excludes_guest_and_requires_same_boot(self):
        previous = {'bootId': BOOT, 'cpuCounters': [80, 0, 50, 800, 10, 0, 0, 0], 'monotonic': 40}
        current = c.cpu_counters('cpu 130 0 70 850 10 0 0 0 30 0')
        self.assertAlmostEqual(c.cpu_percent(current, previous, BOOT, 100), 100 * 40 / 90)
        self.assertIsNone(c.cpu_percent(current, previous, 'other-boot', 100))
        self.assertIsNone(c.cpu_percent(current, previous, BOOT, 300))
        self.assertIsNone(c.cpu_percent([0] * 8, previous, BOOT, 100))

    def test_sequence_survives_boot_and_missing_filesystem_is_unknown(self):
        io = IO(); io.fs_error = True
        sample, checkpoint = c.collect(io, {'sequence': 9, 'bootId': 'old'})
        self.assertEqual(checkpoint['sequence'], 10)
        self.assertIsNone(sample['host']['rootfs'])
        self.assertIn('filesystem_unavailable', sample['host']['errors'])
        self.assertNotIn('private filesystem error', json.dumps(sample))

    def test_full_ids_fixed_endpoint_batches_32_and_whitelist(self):
        io = IO([format(index, '064x') for index in range(65)])
        value = c.docker_observation(io, 123)
        self.assertTrue(value['complete'])
        commands = [entry[0] for entry in io.calls]
        self.assertEqual(sum(command[len(c.DOCKER)] == 'ps' for command in commands), 2)
        self.assertEqual([len(command[command.index(c.TEMPLATE) + 1:]) for command in commands if 'inspect' in command], [32, 32, 1])
        self.assertTrue(all(command[:len(c.DOCKER)] == c.DOCKER for command in commands))
        self.assertIn('--type', commands[1])
        for forbidden in ('.Config.Env', '.Args', '.Mounts', '.State.Health.Log', 'coolify'):
            self.assertNotIn(forbidden, c.TEMPLATE)
        self.assertEqual(set(value['containers'][0]['labels']), {'com.docker.compose.project'})

    def test_docker_samples_keep_batch_time_and_coverage_keeps_close_time(self):
        class ClockedIO(IO):
            def wall(self):
                start = datetime.datetime.fromisoformat(AT.replace('Z', '+00:00'))
                return c.iso(start + datetime.timedelta(seconds=len(self.calls)))

        io = ClockedIO([format(index, '064x') for index in range(33)])
        value = c.docker_observation(io, 123)
        self.assertTrue(value['complete'])
        self.assertEqual({row['observedAt'] for row in value['containers'][:32]}, {'2026-11-14T10:00:02.000Z'})
        self.assertEqual(value['containers'][32]['observedAt'], '2026-11-14T10:00:03.000Z')
        self.assertEqual(value['observedAt'], '2026-11-14T10:00:04.000Z')

    def test_changed_second_ps_is_partial_and_empty_can_be_complete(self):
        io = IO(); io.changed = True
        value = c.docker_observation(io, 123)
        self.assertFalse(value['complete'])
        self.assertEqual(value['errors'], ['docker_changed'])
        self.assertTrue(c.docker_observation(IO([]), 123)['complete'])

    def test_invalid_ids_and_non_whitelisted_fields_fail(self):
        with self.assertRaises(c.CollectionError):
            c.list_ids(b'abc123\n')
        with self.assertRaises(c.CollectionError):
            c.list_ids((ID + '\n' + ID).encode())
        value = container(); value['environment'] = 'never'
        with self.assertRaises(c.CollectionError):
            c.container_value(value, AT)
        value = container(); value['labels']['coolify.projectName'] = 'never'
        with self.assertRaises(c.CollectionError):
            c.container_value(value, AT)

    def test_nil_health_is_unknown_and_zero_dates_are_null(self):
        value = c.container_value(container(), AT)
        self.assertIsNone(value['healthStatus'])
        self.assertIsNone(value['finishedAt'])
        self.assertEqual(value['name'], 'worker')

    def test_popen_environment_is_not_inherited(self):
        calls = []
        def popen(argv, **kwargs):
            calls.append(kwargs)
            return subprocess.Popen(argv, **kwargs)
        with patch.dict(os.environ, {'DOCKER_HOST': 'tcp://untrusted:2375', 'DOCKER_CONTEXT': 'other'}):
            result = c.run_bounded([sys.executable, '-I', '-c', 'print("ok")'], time.monotonic() + 3, 1024, popen=popen)
        self.assertEqual(result, b'ok\n')
        self.assertNotIn('DOCKER_HOST', calls[0]['env'])
        self.assertNotIn('DOCKER_CONTEXT', calls[0]['env'])
        self.assertFalse(calls[0]['shell'])
        self.assertEqual(calls[0]['stderr'], subprocess.DEVNULL)

    def test_popen_output_limit_kills_and_reaps(self):
        processes = []
        def popen(argv, **kwargs):
            process = subprocess.Popen(argv, **kwargs); processes.append(process); return process
        with self.assertRaisesRegex(c.CollectionError, '^docker_output_limit$'):
            c.run_bounded([sys.executable, '-I', '-c', 'import os; os.write(1,b"x"*65536)'], time.monotonic() + 3, 1024, popen=popen)
        self.assertIsNotNone(processes[0].poll())

    def test_popen_timeout_kills_and_reaps_without_stderr(self):
        processes = []
        def popen(argv, **kwargs):
            process = subprocess.Popen(argv, **kwargs); processes.append(process); return process
        with self.assertRaisesRegex(c.CollectionError, '^docker_timeout$'):
            c.run_bounded([sys.executable, '-I', '-c', 'import sys,time; print("secret",file=sys.stderr); time.sleep(5)'], time.monotonic() + 0.15, 1024, popen=popen)
        self.assertIsNotNone(processes[0].poll())

if __name__ == '__main__':
    unittest.main()
