"""Unit tests for src/runner/harness.py. Run: python -m unittest discover supabase/scripts"""
import importlib.util
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parents[2] / "src" / "runner" / "harness.py"
spec = importlib.util.spec_from_file_location("harness_under_test", HARNESS)
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


class HarnessTests(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix="harness_test_"))

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def write(self, name, text):
        (self.dir / name).write_text(text, encoding="utf-8")

    def run_harness(self):
        return json.loads(harness.run(str(self.dir)))

    def by_name(self, out):
        return {r["name"]: r for r in out["results"]}

    def test_pass_fail_error(self):
        self.write("test_a.py", (
            "def test_ok():\n    assert 1 + 1 == 2\n"
            "def test_bad():\n    assert 1 == 2, 'one is not two'\n"
            "def test_boom():\n    {}['x']\n"
            "def helper():\n    raise RuntimeError('not a test')\n"
        ))
        res = self.by_name(self.run_harness())
        self.assertEqual(set(res), {"test_ok", "test_bad", "test_boom"})
        self.assertEqual(res["test_ok"]["status"], "passed")
        self.assertEqual(res["test_bad"]["status"], "failed")
        self.assertIn("one is not two", res["test_bad"]["message"])
        self.assertEqual(res["test_boom"]["status"], "error")
        self.assertIn("KeyError", res["test_boom"]["message"])
        self.assertIn("test_a.py", res["test_boom"]["traceback"])
        self.assertEqual(res["test_ok"]["file"], "test_a.py")

    def test_import_error_in_test_file(self):
        self.write("test_broken.py", "import does_not_exist_xyz\ndef test_x():\n    pass\n")
        self.write("test_fine.py", "def test_y():\n    pass\n")
        out = self.run_harness()
        broken = [r for r in out["results"] if r["file"] == "test_broken.py"]
        self.assertEqual(len(broken), 1)
        self.assertEqual(broken[0]["status"], "error")
        self.assertIn("ModuleNotFoundError", broken[0]["message"])
        self.assertEqual(self.by_name(out)["test_y"]["status"], "passed")

    def test_syntax_error_in_code_under_test(self):
        self.write("lib.py", "def f(:\n")
        self.write("test_lib.py", "import lib\ndef test_x():\n    pass\n")
        out = self.run_harness()
        self.assertEqual(len(out["results"]), 1)
        self.assertEqual(out["results"][0]["status"], "error")

    def test_stdout_and_stderr_captured(self):
        self.write("test_out.py", (
            "import sys\nprint('import-time')\n"
            "def test_p():\n    print('hello from test')\n    print('to stderr', file=sys.stderr)\n"
        ))
        real = sys.stdout
        out = self.run_harness()
        self.assertIs(sys.stdout, real)
        self.assertIn("import-time", out["stdout"])
        self.assertIn("hello from test", out["stdout"])
        self.assertIn("to stderr", out["stdout"])

    def test_fresh_reimport_after_edit(self):
        self.write("lib.py", "VALUE = 1\n")
        self.write("test_lib.py", "import lib\ndef test_v():\n    assert lib.VALUE == 1\n")
        self.assertEqual(self.run_harness()["results"][0]["status"], "passed")
        self.write("lib.py", "VALUE = 2\n")
        self.assertEqual(self.run_harness()["results"][0]["status"], "failed")
        self.write("test_lib.py", "import lib\ndef test_v():\n    assert lib.VALUE == 2\n")
        self.assertEqual(self.run_harness()["results"][0]["status"], "passed")

    def test_module_state_not_shared_between_runs(self):
        self.write("lib.py", "calls = []\n")
        self.write("test_lib.py", "import lib\ndef test_v():\n    lib.calls.append(1)\n    assert len(lib.calls) == 1\n")
        self.assertEqual(self.run_harness()["results"][0]["status"], "passed")
        self.assertEqual(self.run_harness()["results"][0]["status"], "passed")

    def test_sys_path_restored(self):
        before = list(sys.path)
        self.write("test_a.py", "def test_x():\n    pass\n")
        self.run_harness()
        self.assertEqual(sys.path, before)

    def test_no_test_files(self):
        out = self.run_harness()
        self.assertEqual(out["results"], [])


if __name__ == "__main__":
    unittest.main()
