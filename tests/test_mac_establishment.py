import importlib.util
from pathlib import Path
import unittest

path = Path(__file__).resolve().parents[1] / 'ops' / 'mac' / 'reporter.py'
spec = importlib.util.spec_from_file_location('infra_mac_reporter', path)
reporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reporter)


class EstablishmentTest(unittest.TestCase):
    def test_failed_online_is_retried_before_heartbeats(self):
        calls = []
        outcomes = iter([False, True, True])

        def send(token, boot_id, sequence, event):
            calls.append((boot_id, sequence, event))
            return next(outcomes)

        established = False
        for sequence in (10, 25, 40):
            established = reporter.report_cycle('fixture', 'mac-boot-one', sequence, established, send)
        self.assertEqual(calls, [('mac-boot-one', 10, 'online'), ('mac-boot-one', 25, 'online'), ('mac-boot-one', 40, 'heartbeat')])

    def test_rejection_reestablishes_same_boot_with_new_sequence(self):
        calls = []

        def reject(token, boot_id, sequence, event):
            calls.append(event)
            return False

        established = reporter.report_cycle('fixture', 'mac-boot-one', 50, True, reject)
        reporter.report_cycle('fixture', 'mac-boot-one', 65, established, reject)
        self.assertEqual(calls, ['heartbeat', 'online'])


if __name__ == '__main__':
    unittest.main()
