import importlib.util
import pathlib
import unittest

spec = importlib.util.spec_from_file_location('mac_reporter', pathlib.Path(__file__).with_name('reporter.py'))
reporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reporter)


class MacReporterTests(unittest.TestCase):
    def test_boot_id_and_monotonic_sequence(self):
        self.assertEqual(reporter.current_boot_id('{ sec = 1761032337, usec = 123 }'), 'mac-1761032337')
        self.assertEqual(reporter.sequence_from_uptime(123.9), 123)
        self.assertEqual(reporter.sequence_from_uptime(0), 1)
        self.assertEqual(reporter.remaining_delay(100, 15, now=lambda: 103), 12)
        self.assertEqual(reporter.remaining_delay(100, 15, now=lambda: 120), 0)

    def test_redirects_are_never_followed(self):
        handler = reporter.NoRedirect()
        self.assertIsNone(handler.redirect_request(None, None, 302, 'Found', {}, 'https://attacker.invalid'))

    def test_report_body_contains_only_presence_fields(self):
        import json
        from unittest.mock import patch

        class Response:
            status = 204
            def __enter__(self): return self
            def __exit__(self, *_): return False

        class Opener:
            def open(self, request, timeout):
                self.request = request
                self.timeout = timeout
                return Response()

        opener = Opener()
        with patch.object(reporter.urllib.request, 'build_opener') as build:
            self.assertTrue(reporter.send_event('x' * 48, 'mac-boot-123', 2, 'heartbeat', opener))
        self.assertEqual(opener.timeout, 5)
        self.assertEqual(set(json.loads(opener.request.data)), {'bootId', 'sequence', 'event'})
        build.assert_not_called()

    def test_rejects_short_token_before_creating_a_request(self):
        with self.assertRaises(ValueError):
            reporter.send_event('too-short', 'mac-boot-123', 1, 'online', object())


if __name__ == '__main__':
    unittest.main()
