"""Per-agent detached git worktrees: serialized, idempotent, auto-cleaned."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
from collections.abc import Callable
from urllib.parse import unquote, urlparse

from ._util import noop

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def _repo_name(repo: str) -> str:
    repo = repo.rstrip("/")
    parsed = urlparse(repo)
    path = unquote(parsed.path if parsed.scheme else repo)
    if "/_git/" in path:
        name = path.rsplit("/_git/", 1)[1]
    else:
        name = os.path.basename(path)
    return _SAFE.sub("-", name.removesuffix(".git")).strip("-.") or "repo"


def _repo_key(repo: str) -> str:
    """Best-effort repo identity; normalizes common GitHub and Azure clone URL variants."""
    if os.path.exists(repo):
        return "file:" + os.path.realpath(repo)
    if repo.startswith("git@"):
        repo = "ssh://git@" + repo[4:].replace(":", "/", 1)
    parsed = urlparse(repo.rstrip("/").removesuffix(".git"))
    path = unquote(parsed.path).strip("/")
    if "/_git/" in path:
        prefix, name = path.rsplit("/_git/", 1)
        parts = prefix.split("/")
        project = parts[-1]
        if parsed.netloc.endswith(".visualstudio.com"):
            org = parsed.netloc.split(".visualstudio.com", 1)[0]
        elif parsed.netloc == "dev.azure.com" and parts:
            org = parts[0]
        else:
            org = parsed.netloc
        return ("ado:%s/%s/%s" % (org, project, name)).lower()
    return ("%s/%s" % (parsed.netloc, path)).lower()


def ensure_clone(repo: str, dest: str, log: Callable[..., None] = noop) -> str:
    """Clone ``repo`` (a local path or full clone URL) into ``dest`` once; return ``dest``.

    Host-agnostic — the caller passes whatever URL `git clone` understands (GitHub, ADO, GitLab,
    ssh, file). Blob-less so a worktree-only review checkout stays cheap; reused if present.
    """
    if os.path.isdir(os.path.join(dest, ".git")):
        origin = _git(["remote", "get-url", "origin"], cwd=dest, check=False)
        if origin and _repo_key(origin) != _repo_key(repo):
            raise RuntimeError(
                "existing clone %s has origin %s, expected %s" % (dest, origin, repo))
    else:
        os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
        _git(["clone", "--filter=blob:none", "--no-checkout", repo, dest], cwd=os.getcwd())
        log("  clone %s" % repo)
    return dest


def clone_path(repo: str, clone_dir: str) -> str:
    """Return the persistent clone path for ``repo`` under ``clone_dir``."""
    return os.path.join(os.path.expanduser(clone_dir), _repo_name(repo))


def _git_result(args: list[str], cwd: str, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        ["git"] + args, cwd=cwd,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        encoding="utf-8", errors="replace",
    )
    if check and proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc


def _git(args: list[str], cwd: str, check: bool = True) -> str:
    proc = _git_result(args, cwd, check)
    return proc.stdout.strip()


def find_repo_root(start: str) -> str | None:
    try:
        return _git(["rev-parse", "--show-toplevel"], cwd=start)
    except Exception:
        return None


class WorktreeManager:
    def __init__(self, repo_root: str, base_dir: str,
                 logger: Callable[..., None] | None = None, base_ref: str = "HEAD",
                 fetch_remote: bool = True) -> None:
        self.repo_root = repo_root
        self.base_dir = base_dir
        self.base_ref = base_ref
        self.fetch_remote = fetch_remote
        self._log = logger or noop
        self._lock = threading.Lock()
        self._created: list[str] = []

    def create(self, name: str, base_ref: str | None = None, fetch_ref: str | None = None) -> str:
        safe = _SAFE.sub("-", name).strip("-.") or "wt"  # strip dots too: "." / ".." alias base_dir
        path = os.path.join(self.base_dir, safe)
        real_base = os.path.realpath(self.base_dir)
        real_path = os.path.realpath(path)
        if real_path == real_base or not real_path.startswith(real_base + os.sep):
            raise RuntimeError(
                f"unsafe worktree name {name!r} resolves outside the worktree base")
        ref = base_ref or self.base_ref
        with self._lock:
            if path in self._created:
                raise RuntimeError(
                    f"worktree {name!r} is already active — use a unique name per concurrent branch")
            os.makedirs(self.base_dir, exist_ok=True)
            # A ref not in the clone yet (e.g. a PR head on another repo): fetch it and pin
            # the worktree to that fetched commit. Lets one base clone serve every PR's worktree.
            if fetch_ref:
                if self.fetch_remote:
                    _git(["fetch", "--depth", "1", "origin", fetch_ref], cwd=self.repo_root)
                    ref = "FETCH_HEAD"
                else:
                    ref = fetch_ref
            # A real worktree has a `.git` file at its root. Reuse a valid leftover from a
            # crashed run, but rebuild crash debris that isn't a worktree (a bare/partial dir).
            if os.path.exists(path) and not os.path.exists(os.path.join(path, ".git")):
                _git(["worktree", "remove", "--force", path], cwd=self.repo_root, check=False)
                shutil.rmtree(path, ignore_errors=True)
            if not os.path.exists(path):
                _git(["worktree", "add", "--detach", path, ref], cwd=self.repo_root)
            self._created.append(path)
            self._log(f"  worktree + {os.path.basename(path)}")
        return path

    def remove(self, path: str) -> None:
        with self._lock:
            if not os.path.exists(path):
                if path in self._created:
                    self._created.remove(path)
                return
            proc = _git_result(["worktree", "remove", "--force", path],
                               cwd=self.repo_root, check=False)
            if proc.returncode == 0 or not os.path.exists(path):
                if path in self._created:
                    self._created.remove(path)
                self._log(f"  worktree - {os.path.basename(path)}")
            else:
                self._log(
                    f"  ! worktree remove failed for {os.path.basename(path)}: "
                    f"{proc.stderr.strip()}")

    def cleanup_all(self) -> None:
        for path in list(self._created):
            self.remove(path)
        _git(["worktree", "prune"], cwd=self.repo_root, check=False)
