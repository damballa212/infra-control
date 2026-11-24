import pathlib
import shutil
import subprocess
import tempfile
import unittest


SOURCE = pathlib.Path(__file__).with_name('reporter.swift')


@unittest.skipUnless(shutil.which('swiftc'), 'swiftc is required for the native macOS reporter')
class NativeMacReporterTests(unittest.TestCase):
    def test_compiles_and_runs_offline_self_test_without_network_or_secret_output(self):
        with tempfile.TemporaryDirectory(prefix='infra-control-mac-test-') as directory:
            binary = pathlib.Path(directory) / 'mac-reporter'
            subprocess.run(
                ['swiftc', '-O', '-framework', 'AppKit', '-o', str(binary), str(SOURCE)],
                check=True, capture_output=True, text=True, timeout=60,
            )
            result = subprocess.run(
                [str(binary), '--self-test'],
                check=True, capture_output=True, text=True, timeout=10,
            )
            self.assertEqual(result.stdout.strip(), 'self-test: passed')
            self.assertEqual(result.stderr, '')


if __name__ == '__main__':
    unittest.main()
