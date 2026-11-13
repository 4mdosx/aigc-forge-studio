import os
import re
import sys
from importlib.metadata import PackageNotFoundError, version

try:
    from packaging.requirements import Requirement
except Exception:
    Requirement = None

SKIP = {"torch", "torchvision", "torchaudio", "comfyui-frontend-package"}


def normalize(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def unsatisfied(line):
    if Requirement is None:
        body = line.split(";", 1)[0].strip()
        name = re.split(r"[<>=!~\[]", body, maxsplit=1)[0].strip()
        if not name or normalize(name) in SKIP:
            return None
        try:
            version(name)
        except PackageNotFoundError:
            return name
        return None

    req = Requirement(line)
    if normalize(req.name) in SKIP:
        return None
    if req.marker is not None and not req.marker.evaluate():
        return None
    try:
        installed = version(req.name)
    except PackageNotFoundError:
        return req.name
    if req.specifier and not req.specifier.contains(installed, prereleases=True):
        return f"{req.name} {installed} does not satisfy {req.specifier}"
    return None


def expect(dist, env_name):
    expected = os.environ.get(env_name) or ""
    if not expected:
        return None
    try:
        got = version(dist)
    except PackageNotFoundError:
        got = None
    if got != expected:
        return f"{dist} {got} != {expected}"
    return None


def main():
    problems = []
    for dist, env_name in (
        ("torch", "AIGC_EXPECT_TORCH"),
        ("torchvision", "AIGC_EXPECT_TORCHVISION"),
        ("torchaudio", "AIGC_EXPECT_TORCHAUDIO"),
        ("comfyui-frontend-package", "AIGC_EXPECT_FRONTEND"),
    ):
        problem = expect(dist, env_name)
        if problem:
            problems.append(problem)

    if os.environ.get("AIGC_REQUIRE_MANAGER") == "1":
        try:
            version("comfyui-manager")
        except PackageNotFoundError:
            problems.append("comfyui-manager is not installed")

    for path in sys.argv[1:]:
        with open(path, encoding="utf-8") as handle:
            for raw in handle:
                line = raw.split("#", 1)[0].strip()
                if not line or line.startswith(("-", "git+", "http://", "https://")):
                    continue
                try:
                    problem = unsatisfied(line)
                except Exception as exc:
                    problem = f"{path}: {line} ({exc})"
                if problem:
                    problems.append(problem)

    if problems:
        print("\n".join(problems))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
