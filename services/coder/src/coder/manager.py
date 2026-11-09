"""Task life cycle: queue, worktree, pi, commit, checks, review, push and pull request."""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
import threading
import time
from datetime import datetime, timedelta, timezone
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Callable, Optional

from . import github, gitops, review as review_mod
from .config import Config
from .gitops import GitError
from .procs import clean_env, kill_tree, popen_flags
from .rpc import PiProcess
from .store import ACTIVE, Store, now
from .workspaces import ModelRef, Workspace, WorkspaceRegistry

log = logging.getLogger("coder")

QUESTION_METHODS = ("confirm", "select", "input", "editor")
PROVIDER_KEY_ENV = {"openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY"}
PR_FOLLOW_DAYS = 30
KEY_NAMES = ("openai", "anthropic", "github")
# Events that do not count as agent activity when deciding that pi has gone quiet.
QUIET_EVENTS = {"agent_end", "agent_settled", "queue_update", "response", "extension_ui_request"}
ASK_PREFIX = "Question from pi: "  # title prefix of the ask_echo tool (assets/aiembodied-guard.ts)
RUNNING = ("starting", "working", "question", "checks")
# Statuses in which a local task needs the local model server.
LOCAL_NEEDED = ("starting", "working", "question", "paused")
PAUSE_DETAIL = "paused while Kevin talks to Echo"
PAUSE_PROMPT = ("You were paused while the local model was needed elsewhere. Continue where you left off.")
RESUME_PROMPT = ("The runner restarted while you were working. Check the state of the files and continue the "
                 "task where you left off.")


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
        self.used_s = 0.0  # time already spent working, kept across pauses so they do not count against the limit
        self.sup_start: Optional[float] = None
        self.q_s = 0.0  # time spent waiting for answers since sup_start
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
        self._needed = False
        self._hold = False
        self._to_resume: list[str] = []
        self._stop_poll = threading.Event()
        self._poller: Optional[threading.Thread] = None
        self._recover()

    # ---- restart recovery -------------------------------------------------------------------

    def _recover(self) -> None:
        """Deal with tasks that were running when the runner stopped. Resuming starts in resume_all()."""
        for t in self.store.list_tasks():
            if t["status"] not in ACTIVE:
                continue
            tid, wt = t["id"], Path(t["worktree"] or "")
            has_wt = bool(t["worktree"]) and wt.is_dir() and bool(t["base_commit"])
            if not has_wt:
                self._mark_failed(tid, "runner restarted")
            elif t["status"] == "question" and t["questions"] and all(q.get("kind") == "text" for q in t["questions"]):
                continue  # waiting for a text answer; pi is not running, nothing to resume
            elif t["status"] == "pushing":
                self.store.update_task(tid, status="review", error="runner restarted during push",
                                       phase_detail="runner restarted during push")
                self.store.add_event(tid, "runner", {"message": "runner restarted during push; back to review"})
            else:
                self._to_resume.append(tid)

    def _mark_failed(self, tid: str, error: str) -> None:
        self.store.update_task(tid, status="failed", error=error, question=None, current_tool=None, finished_at=now())
        self.store.add_event(tid, "runner", {"message": f"{error}; task marked failed"})

    def resume_all(self) -> None:
        """Restart the tasks found by _recover(): checks run again, pi continues its session."""
        with self._lock:
            ids, self._to_resume = self._to_resume, []
            for tid in ids:
                task = self._get(tid)
                run = self._runs.setdefault(tid, Run())
                run.active = True
                self.store.add_event(tid, "runner", {"message": "runner restarted; resuming"})
                if task["status"] == "checks":
                    entry = self._rerun_checks
                else:
                    entry = self._restart_pi(RESUME_PROMPT, "resumed after a runner restart")
                run.thread = threading.Thread(target=self._worker, args=(tid, run, entry), daemon=True,
                                              name=f"task-{tid}")
                run.thread.start()
        self._notify_all()

    def _rerun_checks(self, tid: str, run: Run) -> bool:
        self._finalize(tid, run)
        return False

    def _notify_all(self) -> None:
        for t in self.store.list_tasks():
            if t["status"] in ACTIVE:
                self._notify(t)

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

    def local_model_needed(self) -> bool:
        return any(t["provider"] == "local" and t["status"] in LOCAL_NEEDED and not self._text_question_only(t)
                   for t in self.store.list_tasks())

    @staticmethod
    def _text_question_only(t: dict) -> bool:
        """True while a task only waits for an answer to a plain-text question (pi is idle then)."""
        qs = t.get("questions") or []
        return t["status"] == "question" and bool(qs) and all(q.get("kind") == "text" for q in qs)

    def status(self) -> dict:
        active = [t["id"] for t in self.store.list_tasks() if t["status"] in ACTIVE]
        return {"local_model_needed": self.local_model_needed(), "active": active, "hold": self._hold}

    def _notify(self, task: dict) -> None:
        if self.on_change:
            try:
                needed = self.local_model_needed()
                self._needed = needed
                self.on_change({"task_id": task["id"], "status": task["status"],
                                "current_tool": task["current_tool"], "question": task["question"],
                                "questions": task["questions"],
                                "local_model_needed": needed})
            except Exception:
                pass

    def _update(self, tid: str, force: bool = False, **fields: Any) -> Optional[dict]:
        if "question" in fields and fields["question"] is None and "questions" not in fields:
            fields["questions"] = []
        with self._lock:
            run = self._runs.get(tid)
            if run and run.stopped and not force:
                return self.store.get_task(tid)
            task = self.store.update_task(tid, **fields)
        if "status" in fields:
            self.store.add_event(tid, "status", {"status": fields["status"], "detail": fields.get("phase_detail"),
                                                 "error": fields.get("error")})
        if task and {"status", "current_tool", "question", "questions"} & set(fields):
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
        if m:
            provider, mid = m.provider, m.id
        else:
            d = self.cfg.default_model
            provider, mid = d["provider"], d["id"]
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
            running = sum(1 for r in self._runs.values() if r.active) + len(self.store.list_tasks("paused"))
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
                run.thread = threading.Thread(target=self._worker, args=(t["id"], run, self._start), daemon=True,
                                              name=f"task-{t['id']}")
                run.thread.start()

    def _worker(self, tid: str, run: Run, entry: Optional[Callable[[str, Run], bool]] = None) -> None:
        try:
            if entry and not entry(tid, run):
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
        if not self._wait_local(tid, run, task):
            return False
        if not self._spawn(tid, run, task, wt, continue_=False):
            return False
        self._update(tid, status="working", phase_detail="pi started")
        brief = build_brief(task["goal"], task["acceptance"], task["scope"])
        if not run.pi or not run.pi.send({"id": "prompt-1", "type": "prompt", "message": brief}):
            self._fail(tid, run, "pi exited before the prompt was sent")
            return False
        return True

    def _wait_local(self, tid: str, run: Run, task: dict) -> bool:
        """For a task on the local model: wait until the local server answers. False if stopped or timed out."""
        if task["provider"] != "local":
            return True
        url = self.cfg.local_llm_url.rstrip("/") + "/models"
        deadline = time.monotonic() + self.cfg.local_wait_s
        announced = False
        while True:
            if run.stopped:
                return False
            if self._hold:  # Echo needs the model server: wait, and do not run down the timeout
                deadline = time.monotonic() + self.cfg.local_wait_s
            elif self._local_ready(url):
                return True
            if not announced:
                announced = True
                self._update(tid, status="starting", phase_detail="waiting for the local model")
            if time.monotonic() >= deadline:
                self._fail(tid, run, "local model did not start")
                return False
            time.sleep(min(self.cfg.local_poll_s, max(0.01, deadline - time.monotonic())))

    @staticmethod
    def _local_ready(url: str) -> bool:
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                return r.status == 200
        except (urllib.error.URLError, OSError, ValueError):
            return False

    def _restart_pi(self, message: str, detail: str, check_continue: bool = False):
        """Entry for a worker: wait for the local model, start pi with --continue and send a prompt."""
        def entry(tid: str, run: Run) -> bool:
            task = self._get(tid)
            wt = Path(task["worktree"] or "")
            if not wt.is_dir():
                self._fail(tid, run, "worktree is gone")
                return False
            if task["provider"] == "local":
                self._update(tid, status="starting", phase_detail="waiting for the local model", question=None,
                             error=None, finished_at=None)
            if not self._wait_local(tid, run, task):
                return False
            if not (run.pi and run.pi.alive):
                if not self._spawn(tid, run, task, wt, continue_=True):
                    return False
                if check_continue and run.pi and run.pi.exited.wait(1.5):
                    self._fail(tid, run, "pi could not continue the session (is --continue supported?)")
                    return False
            self._update(tid, status="working", phase_detail=detail, error=None, finished_at=None, question=None)
            if not run.pi or not run.pi.send({"id": "followup", "type": "prompt", "message": message}):
                self._fail(tid, run, "pi did not accept the message")
                return False
            return True
        return entry

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
            method = ev.get("method")
            # confirm -> answer with `confirmed`; select -> `value` (one of options); input/editor -> `value`
            q["kind"] = {"confirm": "confirm", "select": "select"}.get(method, "input")
            title = str(q.get("title") or "")
            if method == "input" and title.startswith(ASK_PREFIX):
                q.update(kind="ask_echo", title="Question from pi", message=title[len(ASK_PREFIX):])
            q["asked_at"] = now()
            run.pending_question = True
            with self._lock:
                task = self.store.get_task(tid)
                qs = list(task["questions"]) if task else []
                if not any(x.get("id") == q.get("id") for x in qs):
                    qs.append(q)
                self._update(tid, status="question", question=qs[0], questions=qs,
                             phase_detail=str(qs[0].get("message") or qs[0].get("title") or "waiting for an answer"))

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
        last = time.monotonic()
        while True:
            tick = time.monotonic()
            if run.pending_question:  # the time limit does not run while pi waits for an answer
                deadline += tick - last
                run.q_s += tick - last
            last = tick
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
        run.sup_start, run.q_s = time.monotonic(), 0.0
        outcome = self._wait(run, run.sup_start + max(0.0, self._limit_s(task) - run.used_s))
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
        if unchanged and self._asks_in_text(task):
            qid = f"text-{len(self.store.events(tid, 0, 100000))}"
            q = {"id": qid, "method": "text", "kind": "text", "title": "Question from pi",
                 "message": task["last_text"].strip(), "options": None, "asked_at": now()}
            self._update(tid, status="question", question=q, questions=[q], current_tool=None,
                         phase_detail="pi ended its turn with a question")
            return
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

    @staticmethod
    def _asks_in_text(task: dict) -> bool:
        return (task.get("last_text") or "").strip().endswith("?")

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
        if self._text_question_only(task):
            return self.follow_up(tid, message)
        if task["status"] not in ("working", "question"):
            raise CoderError(409, f"cannot steer a task that is {task['status']}")
        self._live_pi(tid).send({"type": "steer", "message": message})
        self.store.add_event(tid, "runner", {"steer": message})
        return task

    def follow_up(self, tid: str, message: str) -> dict:
        task = self._get(tid)
        st = task["status"]
        text_q = self._text_question_only(task)
        if st in ("working", "question") and not text_q:
            self._live_pi(tid).send({"type": "follow_up", "message": message})
            self.store.add_event(tid, "runner", {"follow_up": message})
            return task
        if st != "review" and not text_q:
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
        if task["provider"] == "local":
            # The local model may have been swapped out: wait for it in the worker.
            self._update(tid, status="starting", phase_detail="waiting for the local model", error=None, finished_at=None,
                         question=None)
            self.store.add_event(tid, "runner", {"follow_up": message})
            run.thread = threading.Thread(target=self._worker, args=(tid, run, self._restart_pi(message, "follow-up")),
                                          daemon=True, name=f"task-{tid}")
            run.thread.start()
            return self._get(tid)
        try:
            if not (run.pi and run.pi.alive):
                if not self._spawn(tid, run, task, wt, continue_=True):
                    raise CoderError(409, "pi could not be restarted")
                if run.pi and run.pi.exited.wait(1.5):
                    raise CoderError(409, "pi could not continue the session (is --continue supported?)")
            assert run.pi
            self._update(tid, status="working", phase_detail="follow-up", error=None, finished_at=None, question=None)
            if not run.pi.send({"id": "followup", "type": "prompt", "message": message}):
                raise CoderError(409, "pi did not accept the message")
        except Exception:
            with self._lock:
                run.active = False
            raise
        self.store.add_event(tid, "runner", {"follow_up": message})
        run.thread = threading.Thread(target=self._worker, args=(tid, run), daemon=True, name=f"task-{tid}")
        run.thread.start()
        return self._get(tid)

    def answer(self, tid: str, value: Optional[str], confirmed: Optional[bool], cancelled: Optional[bool],
               dialog_id: Optional[str] = None) -> dict:
        with self._lock:
            task = self._get(tid)
            qs = task["questions"]
            if task["status"] != "question" or not qs:
                raise CoderError(409, "task is not waiting for an answer")
            if dialog_id is None:
                q = qs[0]  # the oldest pending dialog
            else:
                q = next((x for x in qs if x.get("id") == dialog_id), None)
                if q is None:
                    raise CoderError(404, f"no pending question {dialog_id!r}")
            if q.get("kind") == "text":
                if value is None or not value.strip():
                    raise CoderError(400, "a plain-text question needs a value")
                self.store.add_event(tid, "runner", {"answer": {"id": q["id"], "value": value}})
                return self.follow_up(tid, value)
            msg: dict[str, Any] = {"type": "extension_ui_response", "id": q["id"]}
            kind = q.get("kind")
            if cancelled:
                msg["cancelled"] = True
            elif kind == "confirm":
                if confirmed is None:
                    raise CoderError(400, "a confirm question needs confirmed (true or false) or cancelled")
                msg["confirmed"] = confirmed
            elif kind == "select":
                opts = [o.get("value", o.get("label")) if isinstance(o, dict) else o for o in (q.get("options") or [])]
                if value is None or value not in opts:
                    raise CoderError(400, f"a select question needs value to be one of {opts}")
                msg["value"] = value
            elif value is not None:
                msg["value"] = value
            else:
                raise CoderError(400, "this question needs value or cancelled")
            pi = self._live_pi(tid)
            run = self._runs[tid]
            rest = [x for x in qs if x is not q]
            run.pending_question = bool(rest)
            run.last_activity = time.monotonic()
            pi.send(msg)
            self.store.add_event(tid, "runner", {"answer": {k: v for k, v in msg.items() if k != "type"}})
            if rest:
                return self._update(tid, status="question", question=rest[0], questions=rest,
                                    phase_detail=str(rest[0].get("message") or rest[0].get("title"))) or task
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
        if task["status"] not in ("queued", "starting", "working", "question", "checks", "review", "paused"):
            raise CoderError(409, f"cannot cancel a task that is {task['status']}")
        self._stop_run(tid, "cancelled")
        out = self._update(tid, force=True, status="cancelled", current_tool=None, question=None,
                           finished_at=now(), phase_detail="cancelled") or task
        if task["status"] == "paused":
            self.pump()  # a paused task held a slot but has no worker to free it
        return out

    # ---- hold: Echo needs the local model server ---------------------------------------------

    def set_hold(self, hold: bool, reason: Optional[str] = None) -> dict:
        """While held, local tasks are paused (pi stopped, session kept) and new ones wait. Releasing resumes them."""
        with self._lock:
            if self._closed:
                return self.status()
            self._hold = hold
            ids = [t["id"] for t in self.store.list_tasks()
                   if t["provider"] == "local" and (t["status"] in ("working", "question") if hold else t["status"] == "paused")
                   and not self._text_question_only(t)]
        for tid in ids:
            (self._pause if hold else self._resume)(tid, reason)
        if self.on_change:
            try:
                self.on_change({"task_id": None, "hold": hold, "local_model_needed": self.local_model_needed()})
            except Exception:
                pass
        return self.status()

    def _pause(self, tid: str, reason: Optional[str]) -> None:
        run = self._runs.get(tid)
        task = self.store.get_task(tid)
        if not run or not task:
            return
        # Count the time worked so far, minus the time spent waiting for answers.
        if run.sup_start is not None:
            run.used_s += max(0.0, time.monotonic() - run.sup_start - run.q_s)
            run.sup_start = None
        self._stop_run(tid, "paused")
        if run.thread and run.thread.is_alive() and run.thread is not threading.current_thread():
            run.thread.join(10)
        self.store.add_event(tid, "runner", {"message": "paused", "reason": reason})
        self._update(tid, force=True, status="paused", current_tool=None, question=None, questions=[],
                     phase_detail=PAUSE_DETAIL)

    def _resume(self, tid: str, reason: Optional[str] = None) -> None:
        run = self._runs.setdefault(tid, Run())
        with self._lock:
            if run.active:
                return
            run.reset()
            run.active = True
        self.store.add_event(tid, "runner", {"message": "resuming after pause"})
        run.thread = threading.Thread(target=self._worker, args=(tid, run, self._restart_pi(PAUSE_PROMPT, "resumed after a pause")),
                                      daemon=True, name=f"task-{tid}")
        run.thread.start()

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

    # ---- following pull requests -------------------------------------------------------------

    def start_pr_poller(self) -> None:
        """Start the background thread that follows open pull requests (it idles while pr_poll_seconds is 0)."""
        if self._poller:
            return
        self._poller = threading.Thread(target=self._poll_loop, daemon=True, name="pr-poller")
        self._poller.start()

    def _poll_loop(self) -> None:
        while not self._stop_poll.is_set():
            interval = self.cfg.pr_poll_seconds
            if interval > 0:
                self.poll_prs()
            # With polling off, look again soon so that turning it on takes effect without a restart.
            self._stop_poll.wait(interval if interval > 0 else 5)

    def poll_prs(self) -> int:
        """Check every followed pull request once. Returns how many were checked."""
        checked = 0
        for t in self.store.list_tasks():
            if self._stop_poll.is_set():
                break
            if t["pr_url"] and t["pr_state"] in (None, "open") and not self._pr_too_old(t):
                try:
                    self._check_pr(t)
                    checked += 1
                except (CoderError, github.PrError):
                    continue  # logged where it happened; try again next round
        return checked

    @staticmethod
    def _pr_too_old(task: dict) -> bool:
        """True once a PR was opened more than PR_FOLLOW_DAYS ago (it is opened when the task finishes)."""
        try:
            opened = datetime.fromisoformat(task["finished_at"] or task["created_at"])
        except ValueError:
            return False
        return datetime.now(timezone.utc) - opened > timedelta(days=PR_FOLLOW_DAYS)

    def refresh_pr(self, tid: str) -> dict:
        """Check one task's pull request now and return the task."""
        task = self._get(tid)
        if not task["pr_url"]:
            raise CoderError(409, "task has no pull request")
        try:
            return self._check_pr(task)
        except github.PrError as e:
            raise CoderError(502, str(e))

    def _check_pr(self, task: dict) -> dict:
        parsed = github.parse_pr_url(task["pr_url"])
        token = self.keys.get("github")
        if not parsed:
            raise CoderError(409, "the pull request address is not a GitHub pull request")
        if not token and not github.gh_available():
            raise CoderError(409, "no GitHub key and no gh CLI to read the pull request with")
        got = github.read_pr(self.cfg.github_api, token, *parsed)
        fields = {"pr_state": got["pr_state"], "ci_state": got["ci_state"], "pr_checked_at": now()}
        if got["merged_at"]:
            fields["merged_at"] = got["merged_at"]
        changed = (task["pr_state"], task["ci_state"]) != (got["pr_state"], got["ci_state"])
        updated = self.store.update_task(task["id"], **fields) or task
        if changed:
            self.store.add_event(task["id"], "pr", {"pr_state": got["pr_state"], "ci_state": got["ci_state"]})
            self._emit_pr(updated)
        return updated

    def _emit_pr(self, task: dict) -> None:
        if self.on_change:
            try:
                self.on_change({"type": "pr", "task_id": task["id"], "pr_state": task["pr_state"],
                                "ci_state": task["ci_state"]})
            except Exception:
                log.exception("could not publish a pull request update")

    # ---- shutdown ---------------------------------------------------------------------------

    def shutdown(self) -> None:
        self._stop_poll.set()
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
