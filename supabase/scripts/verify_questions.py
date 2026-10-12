"""Verify the seed questions: tests fail on buggy code (each documented bug is
caught), pass on the reference, and supabase/seed.sql is up to date.

Usage: python supabase/scripts/verify_questions.py
"""
import importlib.util
import json
import shutil
import sys
import tempfile
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
ROOT = SCRIPTS.parent.parent
QUESTIONS = ROOT / "supabase" / "questions"
HARNESS = ROOT / "src" / "runner" / "harness.py"


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


harness = load(HARNESS, "harness")
build_seed = load(SCRIPTS / "build_seed.py", "build_seed")


def run_in_tmp(qdir, code_dir):
    tmp = Path(tempfile.mkdtemp(prefix="verify_q_"))
    try:
        for src in sorted((qdir / code_dir).glob("*.py")):
            shutil.copy(src, tmp / src.name)
        for src in sorted((qdir / "tests").glob("*.py")):
            shutil.copy(src, tmp / src.name)
        return json.loads(harness.run(str(tmp)))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def check_question(qdir):
    errors = []
    meta = json.loads((qdir / "question.json").read_text(encoding="utf-8"))
    for key in ("title", "prompt", "constraints", "language", "checklist",
                "followups", "rubric", "bugs"):
        if key not in meta:
            errors.append("question.json missing %r" % key)
    if not 3 <= len(meta.get("bugs", [])) <= 5:
        errors.append("expected 3-5 bugs, found %d" % len(meta.get("bugs", [])))

    ref_names = {p.name for p in (qdir / "reference").glob("*.py")}
    bug_names = {p.name for p in (qdir / "buggy").glob("*.py")}
    if ref_names != bug_names:
        errors.append("buggy/reference file names differ: %s vs %s"
                      % (sorted(bug_names), sorted(ref_names)))
    for bug in meta.get("bugs", []):
        if bug["file_path"] not in bug_names:
            errors.append("bug %r points at unknown file %s" % (bug["title"], bug["file_path"]))

    buggy = run_in_tmp(qdir, "buggy")
    status = {r["name"]: r["status"] for r in buggy["results"]}
    failing = sorted(n for n, s in status.items() if s != "passed")
    print("  buggy: %d tests, %d failing" % (len(status), len(failing)))
    if not failing:
        errors.append("no test fails on the buggy code")
    for bug in meta.get("bugs", []):
        caught = bug.get("caught_by") or []
        if not caught:
            errors.append("bug %r has no caught_by" % bug["title"])
        for name in caught:
            if name not in status:
                errors.append("bug %r: caught_by test %s does not exist" % (bug["title"], name))
            elif status[name] == "passed":
                errors.append("bug %r: %s passes on buggy code" % (bug["title"], name))
        if caught:
            print("    bug %-40s caught by %s" % (bug["title"], ", ".join(caught)))

    ref = run_in_tmp(qdir, "reference")
    bad = [r for r in ref["results"] if r["status"] != "passed"]
    print("  reference: %d tests, %d not passing" % (len(ref["results"]), len(bad)))
    if not ref["results"]:
        errors.append("reference run produced no results")
    for r in bad:
        errors.append("reference %s::%s %s: %s" % (r["file"], r["name"], r["status"], r["message"]))
    return errors


def main():
    all_errors = []
    dirs = sorted(d for d in QUESTIONS.iterdir() if d.is_dir())
    if not dirs:
        all_errors.append("no questions found")
    for qdir in dirs:
        print("question: %s" % qdir.name)
        errs = check_question(qdir)
        all_errors += ["%s: %s" % (qdir.name, e) for e in errs]
    print("seed.sql:")
    if build_seed.main(["--check"]) != 0:
        all_errors.append("seed.sql out of date")
    if all_errors:
        print("\nFAILED")
        for e in all_errors:
            print(" - " + e)
        return 1
    print("\nALL OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
