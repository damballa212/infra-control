"""Offline regression tests; never read production credentials or contact a PC."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('reporter', pathlib.Path(__file__).with_name('linux-reporter.py'))
reporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reporter)


class ReporterTests(unittest.TestCase):
    def test_heartbeat_interval_includes_network_time(self):
        self.assertEqual(reporter.remaining_delay(100, 10, now=lambda: 103), 7)
        self.assertEqual(reporter.remaining_delay(100, 3, now=lambda: 105), 0)

    def test_atomic_state_and_corrupt_primary_recovery(self):
        with tempfile.TemporaryDirectory() as directory:
            state = str(pathlib.Path(directory) / 'sequence.json')
            with patch.object(reporter, 'STATE', state):
                reporter.atomic_write(state, {'bootId': 'fixture', 'sequence': 101})
                self.assertEqual(reporter.previous_state()['sequence'], 101)
                reporter.atomic_write(state + '.backup', {'bootId': 'fixture', 'sequence': 100})
                pathlib.Path(state).write_text('[]')
                self.assertEqual(reporter.previous_state()['sequence'], 101)
                pathlib.Path(state + '.backup').write_text('broken')
                with self.assertRaises(RuntimeError):
                    reporter.previous_state()

    def test_http_rejected_before_network_or_token_transmission(self):
        with tempfile.TemporaryDirectory() as directory:
            config = pathlib.Path(directory) / 'config.json'
            config.write_text(json.dumps({'endpoint': 'http://example.test', 'token': 'synthetic-only'}))
            with patch.object(reporter, 'CONFIG', str(config)), patch.object(reporter.urllib.request, 'build_opener') as network:
                with self.assertRaises(ValueError):
                    reporter.report('online')
                network.assert_not_called()


if __name__ == '__main__':
    unittest.main()
