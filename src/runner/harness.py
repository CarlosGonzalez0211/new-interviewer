"""Tiny test harness (stdlib only, CPython + Pyodide safe).

run(root) -> JSON string:
  {"results":[{"file","name","status","message","traceback"}], "stdout": "..."}
"""
import contextlib
import importlib
import io
import json
import os
import sys
import traceback


def _norm(p):
    return os.path.normcase(os.path.abspath(p))


def _clear_modules(root):
    """Drop cached modules that live under root so every run imports fresh."""
    root_n = _norm(root)
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, "__file__", None)
        if not f:
            continue
        try:
            fn = _norm(f)
        except Exception:
            continue
        if fn.startswith(root_n + os.sep):
            del sys.modules[name]


def _format_tb(exc, root):
    """Traceback limited to frames inside root (falls back to all frames)."""
    root_n = _norm(root)
    frames = traceback.extract_tb(exc.__traceback__)
    mine = [f for f in frames if _norm(f.filename).startswith(root_n + os.sep)]
    use = mine or list(frames)
    lines = ["Traceback (most recent call last):\n"]
    for f in use:
        rel = os.path.relpath(f.filename, root) if mine else f.filename
        lines.append('  File "%s", line %s, in %s\n' % (rel, f.lineno, f.name))
        if f.line:
            lines.append("    %s\n" % f.line.strip())
    lines.extend(traceback.format_exception_only(type(exc), exc))
    return "".join(lines)


def _message(exc):
    text = str(exc)
    if isinstance(exc, AssertionError):
        return text or "assertion failed"
    return "%s: %s" % (type(exc).__name__, text) if text else type(exc).__name__


def _result(file, name, status, message="", tb=""):
    return {"file": file, "name": name, "status": status,
            "message": message, "traceback": tb}


def run(root):
    root = os.path.abspath(root)
    results = []
    buf = io.StringIO()
    added = False
    if root not in sys.path:
        sys.path.insert(0, root)
        added = True
    importlib.invalidate_caches()
    _clear_modules(root)
    sys.dont_write_bytecode = True
    try:
        files = sorted(f for f in os.listdir(root)
                       if f.startswith("test_") and f.endswith(".py"))
        for fname in files:
            modname = fname[:-3]
            with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
                try:
                    mod = importlib.import_module(modname)
                except BaseException as exc:  # noqa: BLE001
                    results.append(_result(fname, "<import>", "error",
                                           _message(exc), _format_tb(exc, root)))
                    continue
                tests = [(n, o) for n, o in vars(mod).items()
                         if n.startswith("test_") and callable(o)
                         and getattr(o, "__module__", modname) == modname]
                tests.sort(key=lambda t: getattr(t[1], "__code__", None)
                           and t[1].__code__.co_firstlineno or 0)
                for name, fn in tests:
                    try:
                        fn()
                        results.append(_result(fname, name, "passed"))
                    except AssertionError as exc:
                        results.append(_result(fname, name, "failed",
                                               _message(exc), _format_tb(exc, root)))
                    except BaseException as exc:  # noqa: BLE001
                        results.append(_result(fname, name, "error",
                                               _message(exc), _format_tb(exc, root)))
    finally:
        _clear_modules(root)
        if added:
            try:
                sys.path.remove(root)
            except ValueError:
                pass
    return json.dumps({"results": results, "stdout": buf.getvalue()})


if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "."
    print(run(target))
