#!/usr/bin/env python3
"""Validate the SDD Claude Code plugin.

Checks the plugin manifest + marketplace manifest agree on name / version / description,
that the version is semver, and that every triggering skill and agent carries the required
frontmatter. Run from the repo root:

    python3 scripts/validate_plugin.py

Exits non-zero on the first category of failures (CI gate). Prints one line per check.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEMVER = re.compile(r"^\d+\.\d+\.\d+$")

errors: list[str] = []
checks = 0


def check(ok: bool, ok_msg: str, fail_msg: str) -> bool:
    global checks
    checks += 1
    if ok:
        print(f"  ok   {ok_msg}")
    else:
        print(f"  FAIL {fail_msg}")
        errors.append(fail_msg)
    return ok


def load_json(rel: str):
    path = ROOT / rel
    if not path.exists():
        errors.append(f"{rel} is missing")
        return None
    try:
        return json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        errors.append(f"{rel} is not valid JSON: {exc}")
        return None


def read_frontmatter(path: Path) -> dict[str, str]:
    """Return the top-level scalar keys of a leading --- YAML frontmatter block."""
    text = path.read_text()
    if not text.startswith("---"):
        return {}
    end = text.find("\n---", 3)
    if end == -1:
        return {}
    block = text[3:end]
    fm: dict[str, str] = {}
    for line in block.splitlines():
        m = re.match(r"^([A-Za-z_][\w-]*):\s*(.*)$", line)
        if m:
            fm[m.group(1)] = m.group(2).strip()
    return fm


def main() -> int:
    print("== manifests ==")
    plugin = load_json(".claude-plugin/plugin.json")
    market = load_json(".claude-plugin/marketplace.json")
    if plugin is None or market is None:
        for e in errors:
            print(f"  FAIL {e}")
        print(f"\nFAILED: {len(errors)} error(s)")
        return 1

    # --- plugin.json: name / version / description ---
    name = plugin.get("name", "")
    version = plugin.get("version", "")
    desc = plugin.get("description", "")
    check(name == "sdd", "plugin name is 'sdd'", f"plugin name is {name!r}, expected 'sdd'")
    check(bool(SEMVER.match(version)), f"plugin version {version!r} is semver", f"plugin version {version!r} is not semver X.Y.Z")
    check(len(desc) >= 50, f"plugin description present ({len(desc)} chars)", f"plugin description too short ({len(desc)} chars)")
    check(bool(plugin.get("license")), "plugin declares a license", "plugin.json has no license")
    check(bool((plugin.get("author") or {}).get("name")), "plugin declares an author", "plugin.json has no author.name")

    # --- marketplace.json: agrees with plugin.json on name / version / description ---
    print("== marketplace ==")
    plugins = market.get("plugins", [])
    entry = next((p for p in plugins if p.get("name") == "sdd"), None)
    if check(entry is not None, "marketplace lists the 'sdd' plugin", "marketplace.json has no plugin named 'sdd'"):
        check(entry.get("version") == version,
              f"marketplace version matches plugin.json ({version})",
              f"marketplace version {entry.get('version')!r} != plugin.json {version!r}")
        check(bool(entry.get("description")), "marketplace entry has a description", "marketplace 'sdd' entry has no description")
        check(bool(entry.get("source")), "marketplace entry has a source", "marketplace 'sdd' entry has no source")

    VALID_MODELS = {"haiku", "sonnet", "opus", "inherit"}
    VALID_EFFORTS = {"low", "medium", "high", "xhigh", "max"}
    agent_names = {p.stem for p in (ROOT / "agents").glob("*.md")}

    def parse_list(v: str) -> list[str]:
        v = v.strip()
        if v.startswith("[") and v.endswith("]"):
            v = v[1:-1]
        return [x.strip() for x in v.split(",") if x.strip()]

    def check_profile(label: str, fm: dict, require: bool):
        """Validate model/effort/agents attributes if present (required on skills)."""
        m, e = fm.get("model"), fm.get("effort")
        if require:
            check(m is not None, f"{label} declares model", f"{label} is missing the model attribute")
            check(e is not None, f"{label} declares effort", f"{label} is missing the effort attribute")
        if m is not None:
            check(m in VALID_MODELS or "-" in m or "." in m,
                  f"{label} model {m!r} is valid", f"{label} model {m!r} not in {sorted(VALID_MODELS)} or a full id")
        if e is not None:
            check(e in VALID_EFFORTS or e.isdigit(),
                  f"{label} effort {e!r} is valid", f"{label} effort {e!r} not in {sorted(VALID_EFFORTS)} or a number")
        ag = fm.get("agents")
        if ag is not None:
            for a in parse_list(ag):
                check(a in agent_names, f"{label} → agent '{a}' exists",
                      f"{label} references agent '{a}' with no agents/{a}.md")

    # --- skills: every trigger skill has name + description + model/effort/agents profile ---
    print("== skills ==")
    skills_dir = ROOT / "skills"
    for skill_md in sorted(skills_dir.glob("*/SKILL.md")):
        base = skill_md.parent.name
        if base == "_shared":
            check(False, "", "skills/_shared must not contain SKILL.md (it would register as a skill)")
            continue
        fm = read_frontmatter(skill_md)
        check(fm.get("name") == base,
              f"skill '{base}' has matching name frontmatter",
              f"skill '{base}': frontmatter name is {fm.get('name')!r}, expected {base!r}")
        check(len(fm.get("description", "")) >= 30 or "description" in _block_keys(skill_md),
              f"skill '{base}' has a description",
              f"skill '{base}' has no/short description")
        check_profile(f"skill '{base}'", fm, require=True)
    check((skills_dir / "_shared").is_dir() and not (skills_dir / "_shared" / "SKILL.md").exists(),
          "_shared is reference-only (no SKILL.md)",
          "_shared is missing or contains a SKILL.md")

    # --- agents: name + description ---
    print("== agents ==")
    for agent_md in sorted((ROOT / "agents").glob("*.md")):
        fm = read_frontmatter(agent_md)
        check(bool(fm.get("name")), f"agent '{agent_md.stem}' has a name", f"agent '{agent_md.name}' has no name frontmatter")
        check("description" in _block_keys(agent_md), f"agent '{agent_md.stem}' has a description", f"agent '{agent_md.name}' has no description")
        check_profile(f"agent '{agent_md.stem}'", fm, require=True)

    print()
    if errors:
        print(f"FAILED: {len(errors)} error(s) out of {checks} checks")
        return 1
    print(f"PASSED: {checks} checks")
    return 0


def _block_keys(path: Path) -> set[str]:
    """Keys present in the frontmatter, including multi-line (folded) ones like `description: >`."""
    text = path.read_text()
    if not text.startswith("---"):
        return set()
    end = text.find("\n---", 3)
    block = text[3:end] if end != -1 else ""
    return {m.group(1) for m in re.finditer(r"^([A-Za-z_][\w-]*):", block, re.M)}


if __name__ == "__main__":
    sys.exit(main())
