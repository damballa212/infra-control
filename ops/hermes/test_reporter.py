"""Offline tests; no real systemd unit or panel is contacted."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('hermes_reporter', pathlib.Path(__file__).with_name('reporter.py'))
reporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reporter)


class HermesReporterTests(unittest.TestCase):
    def test_reads_allowlisted_properties_by_name_even_when_systemd_reorders_them(self):
        calls = []

        def runner(arguments, **kwargs):
            calls.append((arguments, kwargs))
            return type('Completed', (), {'stdout': 'NRestarts=4\nActiveState=active\n'})()

        self.assertEqual(reporter.read_service_state('verified-hermes.service', runner), ('active', 4))
        self.assertEqual(calls[0][0], ['/usr/bin/systemctl', '--user', 'show', 'verified-hermes.service', '--property=ActiveState', '--property=NRestarts'])
        self.assertFalse(calls[0][1].get('shell', False))
        self.assertEqual(calls[0][1]['timeout'], 3)

    def test_unrecognized_or_missing_properties_fail_closed(self):
        def runner(_arguments, **_kwargs):
            return type('Completed', (), {'stdout': 'NRestarts=not-a-number\nSubState=running\n'})()

        self.assertEqual(reporter.read_service_state('verified-hermes.service', runner), ('unknown', 0))

    def test_rejects_untrusted_unit_names_before_invoking_systemctl(self):
        invoked = False

        def runner(*_args, **_kwargs):
            nonlocal invoked
            invoked = True

        with self.assertRaises(ValueError):
            reporter.read_service_state('../../other.service', runner)
        self.assertFalse(invoked)

    def test_report_contains_health_only_and_never_follows_redirects(self):
        class Response:
            status = 204
            def __enter__(self): return self
            def __exit__(self, *_): return False

        class Opener:
            def open(self, request, timeout):
                self.request, self.timeout = request, timeout
                return Response()

        opener = Opener()
        boot = 'ec2-12345678-1234-1234-1234-123456789abc'
        stream = 'reporter-1234567890abcdef'
        self.assertTrue(reporter.send_event('fixture-only-token', boot, stream, 1, 'failed', 3, opener))
        body = json.loads(opener.request.data)
        self.assertEqual(set(body), {'version', 'bootId', 'streamId', 'sequence', 'serviceState', 'restartCount'})
        self.assertEqual(body['serviceState'], 'failed')
        self.assertNotIn('fixture-only-token', opener.request.data.decode())
        self.assertEqual(opener.timeout, 5)
        self.assertIsNone(reporter.NoRedirect().redirect_request(None, None, 302, 'Found', {}, 'https://evil.invalid'))

    def test_loads_token_from_systemd_credential_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            pathlib.Path(directory, 'report-token').write_text('x' * 48)
            self.assertEqual(reporter.load_token(directory), 'x' * 48)
            pathlib.Path(directory, 'report-token').write_text('short')
            with self.assertRaises(ValueError):
                reporter.load_token(directory)


if __name__ == '__main__':
    unittest.main()
