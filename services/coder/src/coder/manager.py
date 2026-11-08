"""Task life cycle: queue, worktree, pi, commit, checks, review, push and pull request."""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Optional

from . import github, gitops, review as review_mod
from .config import Config
from .gitops import GitError
from .procs import clean_env, kill_tree, popen_flags
from .rpc import PiProcess
from .store import Store, now
from .workspaces import ModelRef, Workspace, WorkspaceRegistry

log = logging.getLogger("coder")

QUESTION_METHODS = ("confirm", "select", "input", "editor")
PROVIDER_KEY_ENV = {"openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY"}
KEY_NAMES = ("openai", "anthropic", "github")
# Events that do not count as agent activity when deciding that pi has gone quiet.
QUIET_EVENTS = {"agent_end", "agent_settled", "queue_update", "response", "extension_ui_request"}
RUNNING = ("starting", "working", "question", "checks")


class CoderError(Exception):
    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code, self.message = status_code, message


class Run:
    """In-memory state of one task's pi process and worker thread."""

    def __init__(self) -> None:
        self.pi: Optional[PiProcess] = None
        self.thread: Optional[threading.Thread] = None
        self.active = False
        self.reset()

    def reset(self) -> None:
        self.stopped: Optional[str] = None
        self.settled = threading.Event()
        self.agent_end_at: Optional[float] = None
        self.last_activity = time.monotonic()
        self.prompt_error: Optional[str] = None
        self.pending_question = False
        self.checks_proc: Optional[subprocess.Popen] = None


def slugify(text: str, limit: int = 40) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:limit].strip("-")
    return s or "task"


def text_of(message: Any) -> str:
    if not isinstance(message, dict):
        return ""
    c = message.get("content")
    if isinstance(c, str):
        return c.strip()
    if isinstance(c, list):
        return "\n".join(b.get("text", "") for b in c if isinstance(b, dict) and b.get("type") == "text").strip()
    return ""


def build_brief(goal: str, acceptance: list[str], scope: list[str]) -> str:
    parts = [f"Task: {goal.strip()}"]
    if acceptance:
        parts.append("Acceptance criteria:\n" + "\n".join(f"- {a}" for a in acceptance))
    if scope:
        parts.append("Scope (keep your changes within these paths):\n" + "\n".join(f"- {s}" for s in scope))
    parts.append(
        "Rules:\n"
        "- Work only in this directory (a git worktree made for this task).\n"
        "- Do not push, and do not touch git remotes or open pull requests.\n"
        "- Do not commit; the runner commits your changes when you finish.\n"
        "- Run the project's checks (tests, type checks) if you can.\n"
        "- End with a short summary of what you changed and why.")
    return "\n\n".join(parts)


class TaskManager:
    def __init__(self, cfg: Config, store: Store, workspaces: WorkspaceRegistry,
                 on_change: Optional[Callable[[dict], None]] = None):
        self.cfg, self.store, self.workspaces = cfg, store, workspaces
        self.on_change = on_change
        self.keys: dict[str, str] = {}
        self._runs: dict[str, Run] = {}
        self._lock = threading.RLock()
        self._closed = False
        self.store.mark_stale_failed()

    # ---- keys -------------------------------------------------------------------------------

    def set_keys(self, keys: dict[str, Optional[str]]) -> None:
        with self._lock:
            for name in KEY_NAMES:
                if name in keys:
                    if keys[name]:
                        self.keys[name] = keys[name]  # type: ignore[assignment]
                    else:
                        self.keys.pop(name, None)

    def keys_set(self) -> dict[str, bool]:
        return {n: n in self.keys for n in KEY_NAMES}

    # ---- helpers ----------------------------------------------------------------------------

    def _notify(self, task: dict) -> None:
        if self.on_change:
            try:
                self.on_change({"task_id": task["id"], "status": task["status"],
                                "current_tool": task["current_tool"], "question": task["question"]})
            except Exception:
                pass

    def _update(self, tid: str, force: bool = False, **fields: Any) -> Optional[dict]:
        with self._lock:
            run = self._runs.get(tid)
            if run and run.stopped and not force:
                return self.store.get_task(tid)
            task = self.store.update_task(tid, **fields)
        if "status" in fields:
            self.store.add_event(tid, "status", {"status": fields["status"], "detail": fields.get("phase_detail"),
                                                 "error": fields.get("error")})
        if task and {"status", "current_tool", "question"} & set(fields):
            self._notify(task)
        return task

    def _get(self, tid: str) -> dict:
        t = self.store.get_task(tid)
        if not t:
            raise CoderError(404, f"no task {tid}")
        return t

    def _fail(self, tid: str, run: Run, error: str) -> None:
        if run.pi:
            run.pi.kill()
        self._update(tid, status="failed", error=error, current_tool=None, question=None, finished_at=now(),
                     phase_detail=error)

    def _on_log(self, tid: str, stream: str, line: str) -> None:
        self.store.add_event(tid, "log", {"stream": stream, "line": line[:4000]})

    # ---- creating and scheduling ------------------------------------------------------------

    def _resolve_model(self, ws: Workspace, model: Optional[ModelRef]) -> tuple[str, str]:
        m = model or ws.model
        provider, mid = (m.provider, m.id) if m else ("local", self.cfg.local_model)
        if provider in PROVIDER_KEY_ENV and provider not in self.keys:
            raise CoderError(400, f"no {provider} API key has been set (PUT /v1/keys)")
        return provider, mid

    def create_task(self, workspace_id: str, goal: str, acceptance: list[str], scope: list[str],
                    model: Optional[ModelRef]) -> dict:
        ws = self.workspaces.get(workspace_id)
        if not ws:
            raise CoderError(404, f"unknown workspace {workspace_id!r}")
        provider, mid = self._resolve_model(ws, model)
        tid = self.store.new_id()
        task = self.store.create_task(
            id=tid, workspace_id=workspace_id, goal=goal, acceptance=acceptance, scope=scope, provider=provider,
            model=mid, branch=f"echo/{tid}-{slugify(goal)}", files_touched=[])
        self.store.add_event(tid, "status", {"status": "queued"})
        self._notify(task)
        self.pump()
        return self._get(tid)

    def pump(self) -> None:
        with self._lock:
            if self._closed:
                return
            running = sum(1 for r in self._runs.values() if r.active)
            for t in reversed(self.store.list_tasks("queued")):
                if running >= self.cfg.max_tasks:
                    break
                run = self._runs.setdefault(t["id"], Run())
                if run.active:
                    continue
                run.active = True
                running += 1
                self.store.update_task(t["id"], status="starting")
                self.store.add_event(t["id"], "status", {"status": "starting"})
                self._notify(self.store.get_task(t["id"]))  # type: ignore[arg-type]
                run.thread = threading.Thread(target=self._worker, args=(t["id"], run, True), daemon=True,
                                              name=f"task-{t['id']}")
                run.thread.start()

    def _worker(self, tid: str, run: Run, first: bool) -> None:
        try:
            if first and not self._start(tid, run):
                return
            self._supervise(tid, run)
        except Exception as e:
            log.exception("task %s crashed", tid)
            self._fail(tid, run, f"internal error: {e}")
        finally:
            with self._lock:
                run.active = False
            self.pump()

    def _start(self, tid: str, run: Run) -> bool:
        task = self._get(tid)
        ws = self.workspaces.get(task["workspace_id"])
        if not ws:
            self._fail(tid, run, "workspace no longer exists")
            return False
        wt = self.cfg.worktrees_dir / tid
        try:
            _, base_commit = gitops.create_worktree(Path(ws.path), self.cfg.git_remote, ws.base_branch,
                                                    task["branch"], wt)
        except GitError as e:
            self._fail(tid, run, f"could not create worktree: {e}")
            return False
        self._update(tid, worktree=str(wt), base_commit=base_commit, started_at=now(),
                     phase_detail="worktree ready")
        if run.stopped:
            return False
        if not self._spawn(tid, run, task, wt, continue_=False):
            return False
        self._update(tid, status="working", phase_detail="pi started")
        brief = build_brief(task["goal"], task["acceptance"], task["scope"])
        if not run.pi or not run.pi.send({"id": "prompt-1", "type": "prompt", "message": brief}):
            self._fail(tid, run, "pi exited before the prompt was sent")
            return False
        return True

    def _spawn(self, tid: str, run: Run, task: dict, wt: Path, continue_: bool) -> bool:
        session_dir = self.cfg.sessions_dir / tid
        session_dir.mkdir(parents=True, exist_ok=True)
        ws = self.workspaces.get(task["workspace_id"])
        protected = ";".join(ws.protected_paths or []) if ws else ""
        extra = {"PI_CODING_AGENT_DIR": str(self.cfg.agent_dir), "CODER_PROTECTED_PATHS": protected}
        env_name = PROVIDER_KEY_ENV.get(task["provider"])
        if env_name and task["provider"] in self.keys:
            extra[env_name] = self.keys[task["provider"]]
        argv = self.cfg.pi_argv() + ["--mode", "rpc", "--session-dir", str(session_dir),
                                     "--provider", task["provider"], "--model", task["model"]]
        if continue_:
            argv.append("--continue")
        pi: PiProcess = PiProcess(
            argv, wt, clean_env(extra=extra),
            on_event=lambda ev: self._on_event(tid, run, ev),
            on_log=lambda s, l: self._on_log(tid, s, l),
            on_exit=lambda code: self.store.add_event(tid, "exit", {"code": code}))
        try:
            pi.start()
        except OSError as e:
            self._fail(tid, run, f"could not start pi: {e}")
            return False
        run.pi = pi
        self.store.add_event(tid, "runner", {"message": "pi started", "argv": argv[:1] + argv[1:]})
        return True

    # ---- events from pi ---------------------------------------------------------------------

    def _on_event(self, tid: str, run: Run, ev: dict) -> None:
        t = str(ev.get("type", "unknown"))
        self.store.add_event(tid, t, ev)
        if t not in QUIET_EVENTS:
            run.agent_end_at = None
        run.last_activity = time.monotonic()
        if t == "agent_start":
            run.agent_end_at = None
        elif t == "tool_execution_start":
            name = str(ev.get("toolName", ""))
            fields: dict[str, Any] = {"current_tool": name}
            args = ev.get("args")
            if isinstance(args, dict) and re.search(r"write|edit", name, re.I):
                p = args.get("path") or args.get("file_path")
                if isinstance(p, str) and p:
                    task = self.store.get_task(tid)
                    files = list(task["files_touched"]) if task else []
                    p = self._relative(task, p)
                    if p not in files:
                        files.append(p)
                    fields["files_touched"] = files
            self._update(tid, **fields)
        elif t == "tool_execution_end":
            self._update(tid, current_tool=None)
        elif t == "message_end":
            msg = ev.get("message")
            if isinstance(msg, dict) and msg.get("role") == "assistant":
                text = text_of(msg)
                if text:
                    self._update(tid, last_text=text)
        elif t == "agent_end":
            run.agent_end_at = time.monotonic()
            msgs = ev.get("messages")
            if isinstance(msgs, list):
                for m in reversed(msgs):
                    if isinstance(m, dict) and m.get("role") == "assistant" and text_of(m):
                        self._update(tid, last_text=text_of(m))
                        break
        elif t == "agent_settled":
            run.settled.set()
        elif t == "response":
            if ev.get("success") is False and ev.get("command") in ("prompt", None):
                run.prompt_error = str(ev.get("error") or "pi rejected the prompt")
                run.settled.set()
        elif t == "extension_ui_request" and ev.get("method") in QUESTION_METHODS:
            q = {k: ev.get(k) for k in ("id", "method", "title", "message", "options", "placeholder", "prefill",
                                        "timeout") if k in ev}
            run.pending_question = True
            self._update(tid, status="question", question=q, phase_detail=str(ev.get("title") or "waiting for an answer"))

    @staticmethod
    def _relative(task: Optional[dict], p: str) -> str:
        if task and task.get("worktree"):
            try:
                return Path(p).resolve().relative_to(Path(task["worktree"]).resolve()).as_posix() if Path(p).is_absolute() else p
            except ValueError:
                return p
        return p

    # ---- supervising a run ------------------------------------------------------------------

    def _limit_s(self, task: dict) -> float:
        ws = self.workspaces.get(task["workspace_id"])
        return 60 * ((ws.time_limit_min if ws and ws.time_limit_min else None) or self.cfg.time_limit_min)

    def _wait(self, run: Run, deadline: float) -> str:
        while True:
            if run.stopped:
                return "stopped"
            if run.prompt_error:
                return "error"
            if run.settled.wait(0.05):
                return "settled"
            t = time.monotonic()
            if t > deadline:
                return "timeout"
            if (run.agent_end_at and not run.pending_question
                    and t - max(run.agent_end_at, run.last_activity) >= self.cfg.settle_s):
                return "settled"
            if run.pi and run.pi.exited.is_set():
                return "settled" if run.agent_end_at else "exited"

    def _supervise(self, tid: str, run: Run) -> None:
        task = self._get(tid)
        outcome = self._wait(run, time.monotonic() + self._limit_s(task))
        if run.stopped:
            return
        if outcome == "timeout":
            if run.pi:
                run.pi.send({"type": "abort"})
                time.sleep(min(1.0, self.cfg.cancel_grace_s))
            self._fail(tid, run, "time limit")
        elif outcome == "error":
            self._fail(tid, run, run.prompt_error or "prompt failed")
        elif outcome == "exited":
            code = run.pi.proc.returncode if run.pi and run.pi.proc else None
            self._fail(tid, run, f"pi exited before finishing (code {code})")
        else:
            self._finalize(tid, run)

    def _finalize(self, tid: str, run: Run) -> None:
        task = self._get(tid)
        ws = self.workspaces.get(task["workspace_id"])
        if not ws:
            return self._fail(tid, run, "workspace no longer exists")
        wt, base = Path(task["worktree"]), task["base_commit"]
        self._update(tid, current_tool=None, question=None, phase_detail="committing")
        try:
            gitops.commit_all(wt, " ".join(task["goal"].split())[:200])
            unchanged = gitops.head(wt) == base
        except GitError as e:
            return self._fail(tid, run, f"commit failed: {e}")
        if unchanged:
            if run.pi:
                run.pi.stop(1)
            gitops.remove_worktree(Path(ws.path), wt, task["branch"])
            self._update(tid, status="done", review=review_mod.no_changes_review(), finished_at=now(),
                         phase_detail="no changes were made")
            return
        if ws.checks:
            self._update(tid, status="checks", phase_detail="running checks")
            ok, out = self._run_checks(run, ws.checks, wt)
            if run.stopped:
                return
            self._update(tid, checks_ok=ok, checks_output=out)
        try:
            rev = review_mod.build_review(wt, base, ws.protected_paths or [])
        except GitError as e:
            return self._fail(tid, run, f"review failed: {e}")
        self._update(tid, status="review", review=rev, phase_detail="ready for review")

    def _run_checks(self, run: Run, command: str, cwd: Path) -> tuple[bool, str]:
        p = subprocess.Popen(command, shell=True, cwd=str(cwd), env=clean_env(), stdout=subprocess.PIPE,
                             stderr=subprocess.STDOUT, **popen_flags())
        run.checks_proc = p
        timed_out = False
        try:
            out, _ = p.communicate(timeout=self.cfg.checks_timeout_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            kill_tree(p)
            out, _ = p.communicate()
        text = out.decode("utf-8", errors="replace")
        lines = text.splitlines()[-200:]
        if timed_out:
            lines.append("[checks timed out]")
        return (p.returncode == 0 and not timed_out), "\n".join(lines)

    # ---- controls ---------------------------------------------------------------------------

    def _live_pi(self, tid: str) -> PiProcess:
        run = self._runs.get(tid)
        if not run or not run.pi or not run.pi.alive:
            raise CoderError(409, "pi is not running for this task")
        return run.pi

    def steer(self, tid: str, message: str) -> dict:
        task = self._get(tid)
        if task["status"] not in ("working", "question"):
            raise CoderError(409, f"cannot steer a task that is {task['status']}")
        self._live_pi(tid).send({"type": "steer", "message": message})
        self.store.add_event(tid, "runner", {"steer": message})
        return task

    def follow_up(self, tid: str, message: str) -> dict:
        task = self._get(tid)
        st = task["status"]
        if st in ("working", "question"):
            self._live_pi(tid).send({"type": "follow_up", "message": message})
            self.store.add_event(tid, "runner", {"follow_up": message})
            return task
        if st != "review":
            raise CoderError(409, f"cannot follow up a task that is {st}")
        run = self._runs.setdefault(tid, Run())
        if run.thread and run.thread.is_alive():
            run.thread.join(2)
        wt = Path(task["worktree"] or "")
        with self._lock:
            if run.active or not wt.is_dir():
                raise CoderError(409, "task is busy or its worktree is gone")
            run.reset()
            run.active = True
        try:
            if not (run.pi and run.pi.alive):
                if not self._spawn(tid, run, task, wt, continue_=True):
                    raise CoderError(409, "pi could not be restarted")
                if run.pi and run.pi.exited.wait(1.5):
                    raise CoderError(409, "pi could not continue the session (is --continue supported?)")
            assert run.pi
            self._update(tid, status="working", phase_detail="follow-up", error=None, finished_at=None)
            if not run.pi.send({"id": "followup", "type": "prompt", "message": message}):
                raise CoderError(409, "pi did not accept the message")
        except Exception:
            with self._lock:
                run.active = False
            raise
        self.store.add_event(tid, "runner", {"follow_up": message})
        run.thread = threading.Thread(target=self._worker, args=(tid, run, False), daemon=True, name=f"task-{tid}")
        run.thread.start()
        return self._get(tid)

    def answer(self, tid: str, value: Optional[str], confirmed: Optional[bool], cancelled: Optional[bool]) -> dict:
        task = self._get(tid)
        if task["status"] != "question" or not task["question"]:
            raise CoderError(409, "task is not waiting for an answer")
        msg: dict[str, Any] = {"type": "extension_ui_response", "id": task["question"]["id"]}
        if cancelled:
            msg["cancelled"] = True
        elif value is not None:
            msg["value"] = value
        elif confirmed is not None:
            msg["confirmed"] = confirmed
        else:
            raise CoderError(400, "give value, confirmed or cancelled")
        pi = self._live_pi(tid)
        run = self._runs[tid]
        run.pending_question = False
        run.last_activity = time.monotonic()
        pi.send(msg)
        self.store.add_event(tid, "runner", {"answer": {k: v for k, v in msg.items() if k != "type"}})
        return self._update(tid, status="working", question=None, phase_detail="answered") or task

    def _stop_run(self, tid: str, why: str) -> Optional[Run]:
        run = self._runs.get(tid)
        if not run:
            return None
        run.stopped = why
        run.settled.set()
        if run.checks_proc:
            kill_tree(run.checks_proc)
        if run.pi and run.pi.alive:
            run.pi.send({"type": "abort"})
            if not run.pi.exited.wait(self.cfg.cancel_grace_s):
                run.pi.kill()
            run.pi.kill()
        return run

    def cancel(self, tid: str) -> dict:
        task = self._get(tid)
        if task["status"] not in ("queued", "starting", "working", "question", "checks", "review"):
            raise CoderError(409, f"cannot cancel a task that is {task['status']}")
        self._stop_run(tid, "cancelled")
        return self._update(tid, force=True, status="cancelled", current_tool=None, question=None,
                            finished_at=now(), phase_detail="cancelled") or task

    def discard(self, tid: str) -> dict:
        task = self._get(tid)
        if task["status"] in ("pushing", "discarded"):
            raise CoderError(409, f"cannot discard a task that is {task['status']}")
        run = self._stop_run(tid, "discarded")
        if run and run.thread and run.thread.is_alive() and run.thread is not threading.current_thread():
            run.thread.join(10)
        ws = self.workspaces.get(task["workspace_id"])
        wt = Path(task["worktree"]) if task["worktree"] else self.cfg.worktrees_dir / tid
        if ws:
            gitops.remove_worktree(Path(ws.path), wt, task["branch"])
        else:
            shutil.rmtree(wt, ignore_errors=True)
        return self._update(tid, force=True, status="discarded", current_tool=None, question=None,
                            finished_at=now(), phase_detail="discarded") or task

    # ---- apply ------------------------------------------------------------------------------

    def apply(self, tid: str, draft: bool = False) -> dict:
        with self._lock:
            task = self._get(tid)
            if task["status"] != "review":
                raise CoderError(409, f"task is {task['status']}, not review")
            if (task["review"] or {}).get("protected_violations"):
                raise CoderError(409, "protected paths were changed; discard or follow up instead")
            self._update(tid, status="pushing", phase_detail="pushing the branch")
        ws = self.workspaces.get(task["workspace_id"])
        if not ws:
            self._update(tid, status="review", error="workspace no longer exists")
            raise CoderError(409, "workspace no longer exists")
        repo, wt, remote = Path(ws.path), Path(task["worktree"]), self.cfg.git_remote
        run = self._runs.get(tid)
        if run and run.pi:
            run.pi.stop(1)
        try:
            gitops.git("push", "-u", remote, task["branch"], cwd=wt, timeout=300)
        except GitError as e:
            self._update(tid, status="review", error=f"push failed: {e}", phase_detail="push failed")
            raise CoderError(502, f"push failed: {e}")
        pr_url, detail = None, f"Branch {task['branch']} pushed."
        owner_repo = gitops.parse_owner_repo(gitops.remote_url(repo, remote))
        if not owner_repo:
            detail += " The remote is not a GitHub repository, so no pull request was opened."
        else:
            title = " ".join(task["goal"].split())[:70]
            body = self._pr_body(task)
            try:
                if self.keys.get("github"):
                    pr_url = github.create_pr_api(self.cfg.github_api, self.keys["github"], *owner_repo,
                                                  task["branch"], ws.base_branch, title, body, draft)
                elif github.gh_available():
                    pr_url = github.create_pr_gh(wt, task["branch"], ws.base_branch, title, body, draft)
                else:
                    detail += " No GitHub key and no gh CLI: open the pull request by hand."
            except github.PrError as e:
                detail += f" The pull request could not be opened: {e}"
        gitops.remove_worktree(repo, wt)
        return self._update(tid, status="done", pr_url=pr_url, error=None, finished_at=now(), phase_detail=detail) or task

    @staticmethod
    def _pr_body(task: dict) -> str:
        rev = task["review"] or {}
        parts = ["## Task", task["goal"]]
        if task["acceptance"]:
            parts += ["## Acceptance criteria"] + [f"- {a}" for a in task["acceptance"]]
        if task["scope"]:
            parts += ["## Scope"] + [f"- {s}" for s in task["scope"]]
        if task["checks_ok"] is None:
            parts += ["## Checks", "No checks were configured."]
        else:
            parts += ["## Checks", "Passed." if task["checks_ok"] else "Failed.",
                      "```\n" + "\n".join((task["checks_output"] or "").splitlines()[-30:]) + "\n```"]
        parts += ["## Changes", rev.get("summary", "")]
        if rev.get("flags"):
            parts += ["## Review flags"] + [f"- {f}" for f in rev["flags"]]
        if task["last_text"]:
            parts += ["## Agent summary", task["last_text"]]
        parts += ["", "Opened by Echo's coding runner"]
        return "\n\n".join(parts)

    # ---- shutdown ---------------------------------------------------------------------------

    def shutdown(self) -> None:
        with self._lock:
            self._closed = True
            runs = list(self._runs.values())
        for r in runs:
            r.stopped = r.stopped or "shutdown"
            r.settled.set()
            if r.checks_proc:
                kill_tree(r.checks_proc)
            if r.pi:
                r.pi.kill()
