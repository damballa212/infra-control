"""Pruebas sin red: nunca leen credenciales de producción ni contactan una PC."""
import importlib.util
import json
import pathlib
import tempfile
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('commander', pathlib.Path(__file__).with_name('linux-commander.py'))
commander = importlib.util.module_from_spec(spec)
spec.loader.exec_module(commander)

ID = '123e4567-e89b-12d3-a456-426614174000'


class DecideTests(unittest.TestCase):
    def test_power_requires_capability_fresh_id_and_same_boot(self):
        order = {'id': ID, 'command': 'off', 'expectedBootId': 'boot-1'}
        self.assertTrue(commander.decide(order, 'boot-1', ['ping', 'power'], set()))
        self.assertFalse(commander.decide(order, 'boot-1', ['ping'], set()))
        self.assertFalse(commander.decide(order, 'boot-2', ['ping', 'power'], set()))
        self.assertFalse(commander.decide(order, 'boot-1', ['ping', 'power'], {ID}))

    def test_ping_needs_no_boot_id(self):
        self.assertTrue(commander.decide({'id': ID, 'command': 'ping', 'expectedBootId': ''}, 'boot-1', ['ping'], set()))

    def test_unknown_or_malformed_orders_are_rejected(self):
        for order in ({'id': ID, 'command': 'rm -rf /', 'expectedBootId': 'b'}, {'id': 'x', 'command': 'off', 'expectedBootId': 'b'},
                      {'command': 'off'}, 'off', None, {'id': ID, 'command': 'default-windows', 'expectedBootId': 'b'}):
            self.assertFalse(commander.decide(order, 'b', ['ping', 'power'], set()), order)


class ExecuteTests(unittest.TestCase):
    def test_ping_runs_nothing(self):
        run = MagicMock()
        self.assertIsNone(commander.execute('ping', run))
        run.assert_not_called()

    def test_power_calls_the_fixed_helper_without_shell_or_free_arguments(self):
        run = MagicMock()
        commander.execute('windows', run)
        self.assertEqual(run.call_args.args[0], ['/usr/local/sbin/infra-control-pc', 'windows'])
        self.assertNotIn('shell', run.call_args.kwargs)

    def test_unknown_command_is_never_executed(self):
        run = MagicMock()
        with self.assertRaises(ValueError):
            commander.execute('default-windows', run)
        run.assert_not_called()


class SettingsTests(unittest.TestCase):
    def write(self, directory, name, value):
        path = pathlib.Path(directory) / name
        path.write_text(json.dumps(value))
        return str(path)

    def test_defaults_to_ping_only_and_derives_the_commands_url(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.write(directory, 'c.json', {'endpoint': 'https://panel.example/api/desktop/events', 'token': 'synthetic-only'})
            settings = commander.load_settings(config, str(pathlib.Path(directory) / 'missing.json'))
            self.assertEqual(settings['caps'], ['ping'])
            self.assertEqual(settings['base'], 'https://panel.example/api/desktop/commands')

    def test_unknown_capabilities_are_dropped(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.write(directory, 'c.json', {'endpoint': 'https://panel.example/api/desktop/events', 'token': 'synthetic-only'})
            caps = self.write(directory, 'caps.json', {'caps': ['ping', 'power', 'root-shell']})
            self.assertEqual(commander.load_settings(config, caps)['caps'], ['ping', 'power'])

    def test_http_endpoint_is_rejected_before_any_network_use(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.write(directory, 'c.json', {'endpoint': 'http://example.test/api/desktop/events', 'token': 'synthetic-only'})
            with patch.object(commander.urllib.request, 'build_opener') as network:
                with self.assertRaises(ValueError):
                    commander.load_settings(config)
                network.assert_not_called()


if __name__ == '__main__':
    unittest.main()
