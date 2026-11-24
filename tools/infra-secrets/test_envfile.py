import os
import stat
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path

import envfile

FAKE = "FAKE_ONLY_" + "a1" * 16


class EnvFileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def mode(self, path):
        return stat.S_IMODE(os.stat(path).st_mode)

    def test_creates_file_0600_with_exact_content(self):
        target = self.dir / ".env"
        report = envfile.write_env(target, {"OPENAI_API_KEY": FAKE})
        self.assertEqual(target.read_text(), f"OPENAI_API_KEY={FAKE}\n")
        self.assertEqual(self.mode(target), 0o600)
        self.assertEqual(report.names, ("OPENAI_API_KEY",))
        self.assertNotIn(FAKE, repr(report))

    def test_merges_and_preserves_other_lines(self):
        target = self.dir / ".env"
        target.write_text("# comentario\nKEEP=1\nOPENAI_API_KEY=viejo\n")
        envfile.write_env(target, {"OPENAI_API_KEY": FAKE, "NEW_ONE": "x"})
        lines = target.read_text().splitlines()
        self.assertEqual(lines[:2], ["# comentario", "KEEP=1"])
        self.assertIn(f"OPENAI_API_KEY={FAKE}", lines)
        self.assertEqual(lines.count(f"OPENAI_API_KEY={FAKE}"), 1)
        self.assertIn("NEW_ONE=x", lines)
        self.assertEqual(self.mode(target), 0o600)

    def test_special_characters_are_single_quoted(self):
        target = self.dir / ".env"
        envfile.write_env(target, {"PASS": "a b$c#d"})
        self.assertEqual(target.read_text(), "PASS='a b$c#d'\n")

    def test_value_with_single_quote_uses_escaped_double_quotes(self):
        target = self.dir / ".env"
        envfile.write_env(target, {"PASS": "it's $x"})
        self.assertEqual(target.read_text(), 'PASS="it\'s \\$x"\n')

    def test_rejects_bad_names_and_multiline_values_without_leaking(self):
        target = self.dir / ".env"
        for name, value in (("bad-name", "v"), ("1ABC", "v"), ("OK", "a\nb"), ("OK", "a\x00b"), ("OK", "a\rb")):
            with self.assertRaises(envfile.EnvFileError) as ctx:
                envfile.write_env(target, {name: value})
            self.assertNotIn("a\nb", str(ctx.exception))
        self.assertFalse(target.exists())

    def test_refuses_symlink_target(self):
        real = self.dir / "real"
        real.write_text("X=1\n")
        link = self.dir / ".env"
        link.symlink_to(real)
        with self.assertRaises(envfile.EnvFileError):
            envfile.write_env(link, {"A": "b"})
        self.assertEqual(real.read_text(), "X=1\n")

    def test_refuses_missing_parent_directory(self):
        with self.assertRaises(envfile.EnvFileError):
            envfile.write_env(self.dir / "nope" / ".env", {"A": "b"})

    def test_tightens_loose_existing_permissions(self):
        target = self.dir / ".env"
        target.write_text("X=1\n")
        os.chmod(target, 0o644)
        envfile.write_env(target, {"A": "b"})
        self.assertEqual(self.mode(target), 0o600)

    def test_adds_entry_to_gitignore_inside_a_repo(self):
        subprocess.run(["git", "init", "-q", str(self.dir)], check=True)
        sub = self.dir / "app"
        sub.mkdir()
        report = envfile.write_env(sub / ".env.local", {"A": "b"})
        self.assertTrue(report.gitignored)
        ignored = subprocess.run(["git", "-C", str(self.dir), "check-ignore", "-q", "app/.env.local"])
        self.assertEqual(ignored.returncode, 0)
        envfile.write_env(sub / ".env.local", {"A": "c"})
        self.assertEqual((self.dir / ".gitignore").read_text().count("app/.env.local"), 1)

    def test_outside_a_repo_reports_not_gitignored(self):
        report = envfile.write_env(self.dir / ".env", {"A": "b"})
        self.assertIsNone(report.gitignored)

    def test_works_without_fchmod_like_windows(self):
        with unittest.mock.patch.object(envfile, "HAS_FCHMOD", False), unittest.mock.patch.object(envfile, "O_NOFOLLOW", 0):
            envfile.write_env(self.dir / ".env", {"A": "b"})
        self.assertEqual((self.dir / ".env").read_text(), "A=b\n")

    def test_no_temp_files_left_behind(self):
        envfile.write_env(self.dir / ".env", {"A": "b"})
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), [".env"])


if __name__ == "__main__":
    unittest.main()
