#!/usr/bin/env python3
"""Regenerate NODE_NEEDS_DOM in vitest.config.ts (node/jsdom project split).

A `.test.ts` file needs jsdom when it — or anything in its transitive source
closure — touches real DOM APIs. Test-file-only heuristics miss the common
case: a pure-looking test importing a store/lib that hits bare `window` at
module scope or runtime (e.g. completion-poll.ts).

Method: resolve each test's static imports (vite aliases mirrored, barrels,
dynamic import() with static specifiers, require) and flag DOM use in any
reachable source file: bare `window.`/`document.` outside `typeof` guards,
browser-only ctors (OffscreenCanvas, FileReader…) anywhere, jsdom-only APIs
in un-stubbed files. Test files that self-provision via vi.stubGlobal count
as safe for window/document (setup shims cover localStorage/observers).

This is a first-cut classifier: the suite itself is the verifier — a
misclassified file fails loudly under node, then gets added to the list.
Residual risk: env-dependent branches (`typeof window !== 'undefined'`)
taking the other leg under node while the test still passes. Review
unit-project passes with that in mind.

Usage: python3 scripts/classify-node-tests.py [--check]
  --check: exit 1 if the config list differs (CI drift gate).
"""

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
CONFIG = ROOT / "vitest.config.ts"
BEGIN = "// GENERATED-BEGIN (do not hand-edit; see scripts/classify-node-tests.py)"
END = "// GENERATED-END"
DEPTH = 12

HARD_TEST = re.compile(r"testing-library|from ['\"]vitest.*jsdom|happy-dom")
# jsdom-only APIs with no node equivalent and no setup shim.
HARD_ENV = re.compile(
    r"matchMedia|getComputedStyle|HTMLElement|"
    r"requestAnimationFrame|customElements"
)
# Browser-only constructors with no node equivalent (and no setup shim). A
# test-side stub prevents the ReferenceError but NOT the behavioral delta
# (proven: image-resize stubs OffscreenCanvas yet asserts canvas-chain
# output) — so these force jsdom with NO stub exemption, unlike BARE_DOM.
BROWSER_ONLY_CTOR = re.compile(
    r"OffscreenCanvas|createImageBitmap|FileReader|AudioContext|"
    r"webkitAudioContext|new Image\(|HTMLCanvasElement|HTMLImageElement|"
    r"HTMLAudioElement|HTMLVideoElement|\bNotification\b"
)
# Any `typeof X` line is crash-safe under node (evaluates to 'undefined',
# never throws). Branch divergence (feature-detect taking the other leg) is
# still possible — but tests asserting the main-path behavior then fail
# loudly and get moved to jsdom.
TYPEOF_GUARD = re.compile(r"typeof\s")
# Bare DOM access, ignoring `typeof window`-style guards (node-safe).
BARE_DOM = re.compile(r"(?<!typeof )(?<!typeof\()(\bwindow\.|\bdocument\.)")


def _has_unguarded(line: str, pattern: re.Pattern) -> bool:
    if TYPEOF_GUARD.search(line):
        return False
    return bool(pattern.search(line))
SELF_PROVIDED = re.compile(
    r"stubGlobal|spyOn\(|defineProperty\(.*window|defineProperty\(.*document"
)
FROM_RE = re.compile(r"from\s*['\"]([^'\"]+)['\"]")
REQUIRE_RE = re.compile(r"require\(\s*['\"]([^'\"]+)['\"]\s*\)")
# Dynamic import() with a STATIC specifier is a real edge (vitest tracks it
# as dynamicDeps). Variable specifiers are unresolvable — ignored here.
DYNAMIC_IMPORT_RE = re.compile(r"import\(\s*['\"]([^'\"]+)['\"]\s*\)")
# Mirror of vite.config.ts resolve.alias (vitest extends the vite config, so
# tests resolve the same way). Longest-prefix match. Entries pointing at
# node_modules (react, driver.js) are intentionally absent — out of scope.
ALIASES: list[tuple[str, pathlib.Path]] = []


def _init_aliases() -> None:
    shared = ROOT.parent / "shared" / "src"
    table = {
        "@/debug/dev-only": SRC / "debug" / "dev-only.ts",
        "@hermes/shared/billing": shared / "billing-types.ts",
        "@hermes/shared/color": shared / "color.ts",
        "@hermes/shared": shared,
        "@hermes/plugin-sdk": SRC / "sdk" / "index.ts",
        "@": SRC,
    }
    for key in sorted(table, key=len, reverse=True):
        ALIASES.append((key, table[key]))


_init_aliases()

SOURCE_EXTS = (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json")
SKIP_EXTS = (".css", ".scss", ".less", ".svg", ".png", ".jpg", ".ico", ".woff2")


def resolve_spec(spec: str, importer: pathlib.Path) -> pathlib.Path | None:
    # Strip Vite query suffixes (?raw, ?url, ?worker…) — the file underneath
    # is what matters.
    spec = spec.split("?", 1)[0]
    base: pathlib.Path | None = None
    for prefix, target in ALIASES:
        if spec == prefix or spec.startswith(prefix + "/"):
            rest = spec[len(prefix):].strip("/")
            base = target if not rest else target.joinpath(*rest.split("/"))
            break
    if base is None:
        if not spec.startswith("."):
            return None  # bare package import (node_modules) — out of scope
        base = (importer.parent / spec).resolve()
        try:
            base.relative_to(ROOT.parent)
        except ValueError:
            return None
    if base.suffix in SKIP_EXTS:
        return None
    candidates = [base] if base.suffix else []
    if not base.suffix:
        candidates = [base.with_suffix(e) for e in SOURCE_EXTS]
        candidates.append(base / "index.ts")
        candidates.append(base / "index.tsx")
    for c in candidates:
        if c.is_file():
            return c
    return None


def source_uses_dom(path: pathlib.Path) -> bool:
    try:
        txt = path.read_text(errors="ignore")
    except OSError:
        return False
    for line in txt.splitlines():
        if _has_unguarded(line, BARE_DOM) or _has_unguarded(line, BROWSER_ONLY_CTOR):
            return True
    return False


def closure_uses_dom(test: pathlib.Path) -> bool:
    seen: set[pathlib.Path] = set()
    stack: list[tuple[pathlib.Path, int]] = [(test, 0)]
    while stack:
        path, depth = stack.pop()
        if path in seen or depth > DEPTH:
            continue
        seen.add(path)
        try:
            txt = path.read_text(errors="ignore")
        except OSError:
            continue
        if path != test and source_uses_dom(path):
            return True
        if depth == DEPTH:
            continue
        specs = (
            set(FROM_RE.findall(txt))
            | set(REQUIRE_RE.findall(txt))
            | set(DYNAMIC_IMPORT_RE.findall(txt))
        )
        for spec in specs:
            target = resolve_spec(spec, path)
            if target is not None and target not in seen:
                stack.append((target, depth + 1))
    return False


def needs_dom(test: pathlib.Path) -> bool:
    txt = test.read_text(errors="ignore")
    if HARD_TEST.search(txt):
        return True
    if HARD_ENV.search(txt) and not SELF_PROVIDED.search(txt):
        return True
    for line in txt.splitlines():
        # Browser-only ctors (canvas, FileReader…): a stub kills the
        # ReferenceError but not the behavioral delta — no exemption.
        if _has_unguarded(line, BROWSER_ONLY_CTOR):
            return True
    # Bare window./document. in the test body itself (helpers, module scope):
    # under jsdom the globals just exist. Safe only when the file installs
    # them via stubGlobal/spyOn.
    if not SELF_PROVIDED.search(txt):
        for line in txt.splitlines():
            if _has_unguarded(line, BARE_DOM):
                return True
    return closure_uses_dom(test)


def classify() -> list[str]:
    return sorted(
        str(f.relative_to(ROOT)) for f in SRC.rglob("*.test.ts") if needs_dom(f)
    )


def render(entries: list[str]) -> str:
    lines = ["const NODE_NEEDS_DOM: string[] = ["]
    lines += [f"  '{e}'," for e in entries]
    lines.append("]")
    return "\n".join(lines) + "\n"


def main() -> int:
    entries = classify()
    print(f"test.ts files needing jsdom: {len(entries)}")
    text = CONFIG.read_text()
    start = text.index(BEGIN) + len(BEGIN)
    stop = text.index(END)
    new_block = "\n" + render(entries)
    if "--check" in sys.argv:
        return 0 if text[start:stop] == new_block else 1
    CONFIG.write_text(text[:start] + new_block + text[stop:])
    print(f"wrote {len(entries)} entries into {CONFIG}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
