"""版本号一致性校验。

版本号的唯一事实来源是 CHANGELOG.md 第一段 `## <version> · <date>`。
本脚本把其余所有需要跟着改的地方做一次比对，避免出现
「CHANGELOG 已经是 1.2.3，README 还写着 1.2.0」这种漏改。

用法：
    python scripts/check-version.py          # 只检查，不一致时退出码 1
    python scripts/check-version.py --fix    # 把可自动改的项写回去
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHANGELOG = ROOT / "CHANGELOG.md"

# (相对路径, 正则, 说明)；正则需要含一个 version 分组
TARGETS: list[tuple[str, str, str]] = [
    ("README.md", r"当前版本：\*\*v(\d+\.\d+\.\d+)\*\*", "README 当前版本"),
    ("docs/01-overview.md", r"> 版本基线：\*\*v(\d+\.\d+\.\d+)\*\*", "文档版本基线"),
    ("docs/04-api.md", r'"changelog": \{"version":"(\d+\.\d+\.\d+)"', "API 文档示例"),
    ("docs/05-deployment.md", r"card-service:v(\d+\.\d+\.\d+)\s+#\s*语义化版本标签", "部署文档镜像标签"),
    ("DEPLOY.md", r"card-service:(\d+\.\d+\.\d+)", "DEPLOY 镜像标签"),
]


def changelog_version() -> str:
    text = CHANGELOG.read_text(encoding="utf-8")
    for line in text.splitlines():
        match = re.match(r"^##\s+(\d+\.\d+\.\d+)\b", line)
        if match:
            return match.group(1)
    raise SystemExit("CHANGELOG.md 里没找到 `## <version>` 标题")


def package_version(path: Path) -> str:
    return json.loads(path.read_text(encoding="utf-8")).get("version", "")


def main() -> int:
    fix = "--fix" in sys.argv
    want = changelog_version()
    problems: list[str] = []
    print(f"基准版本（CHANGELOG.md）：{want}")

    for rel, pattern, label in TARGETS:
        path = ROOT / rel
        if not path.is_file():
            problems.append(f"{label}: 文件不存在 {rel}")
            continue
        text = path.read_text(encoding="utf-8")
        found = re.findall(pattern, text, flags=re.MULTILINE)
        if not found:
            problems.append(f"{label}: 未匹配到版本号（{rel}）")
            continue
        stale = sorted({item for item in found if item != want})
        if stale:
            problems.append(f"{label}: {', '.join(stale)} -> 应为 {want}（{rel}）")
            if fix:
                named = pattern.replace("(", "(?P<v>", 1)
                text = re.sub(
                    named,
                    lambda m: m.group(0).replace(m.group("v"), want),
                    text,
                    flags=re.MULTILINE | re.DOTALL,
                )
                path.write_text(text, encoding="utf-8")
                print(f"  已修正 {rel}")
        else:
            print(f"  ok  {label}")

    for rel in ("frontend/package.json", "frontend/package-lock.json"):
        path = ROOT / rel
        if not path.is_file():
            continue
        got = package_version(path)
        if got != want:
            problems.append(f"{rel}: {got or '(空)'} -> 应为 {want}")
            if fix:
                data = json.loads(path.read_text(encoding="utf-8"))
                data["version"] = want
                if "packages" in data and "" in data["packages"]:
                    data["packages"][""]["version"] = want
                path.write_text(
                    json.dumps(data, ensure_ascii=False, indent=2) + "\n",
                    encoding="utf-8",
                )
                print(f"  已修正 {rel}")
        else:
            print(f"  ok  {rel}")

    if not problems:
        print("\n全部一致。")
        return 0

    if fix:
        print("\n已按 --fix 改写，请重新运行确认。")
        return 0

    print("\n不一致项：")
    for item in problems:
        print("  - " + item)
    print("\n加 --fix 可自动改写。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
