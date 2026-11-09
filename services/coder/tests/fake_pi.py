"""A fake pi for tests: speaks the RPC protocol on stdin/stdout.

FAKE_PI_MODE: normal | question | ask | two | textq | hang | nosettled
FAKE_PI_FILE: file to write in the cwd (default hello.txt)
FAKE_PI_ENV_DUMP / FAKE_PI_ARGV_DUMP: write the environment / argv as JSON to this path
"""
import json
import os
import queue
import sys
import threading
import time

if "--version" in sys.argv:
    print("fake-pi 9.9.9")
    sys.exit(0)

mode = os.environ.get("FAKE_PI_MODE", "normal")
target = os.environ.get("FAKE_PI_FILE", "hello.txt")
out_lock = threading.Lock()
answers: "queue.Queue[dict]" = queue.Queue()
aborted = threading.Event()
runs = 0

if os.environ.get("FAKE_PI_ENV_DUMP"):
    with open(os.environ["FAKE_PI_ENV_DUMP"], "w") as f:
        json.dump({"env": dict(os.environ), "cwd": os.getcwd()}, f)
if os.environ.get("FAKE_PI_ARGV_DUMP"):
    with open(os.environ["FAKE_PI_ARGV_DUMP"], "w") as f:
        json.dump(sys.argv[1:], f)


def emit(obj):
    with out_lock:
        sys.stdout.write(json.dumps(obj) + "\n")
        sys.stdout.flush()


def flow(n, message=None):
    emit({"type": "agent_start"})
    emit({"type": "future_unknown_event", "x": 1})
    print("some non-json noise", flush=True)
    print("a stderr line", file=sys.stderr, flush=True)
    emit({"type": "turn_start"})
    write = True
    if mode == "question":
        emit({"type": "extension_ui_request", "id": "q1", "method": "confirm", "title": "Delete things?",
              "message": "rm -rf build"})
        emit({"type": "extension_ui_request", "id": "n1", "method": "notify", "message": "hi"})
        a = answers.get()
        write = bool(a.get("confirmed"))
    note = ""
    if mode == "ask":
        emit({"type": "extension_ui_request", "id": "a1", "method": "input",
              "title": "Question from pi: Which port?", "placeholder": "type the answer"})
        a = answers.get()
        note = a.get("value") or "no answer"
    if mode == "two":
        emit({"type": "extension_ui_request", "id": "q1", "method": "confirm", "title": "Delete things?",
              "message": "rm -rf build"})
        emit({"type": "extension_ui_request", "id": "a1", "method": "input",
              "title": "Question from pi: Which port?"})
        got = {}
        for _ in range(2):
            a = answers.get()
            got[a["id"]] = a
        note = got["a1"].get("value") or "no answer"
    if mode == "textq" and n == 1:
        write = False
    if mode == "textq" and n > 1:
        note = message or ""
    if mode == "hang":
        emit({"type": "tool_execution_start", "toolCallId": "h", "toolName": "bash", "args": {"command": "sleep 100"}})
        aborted.wait(60)
        emit({"type": "agent_end", "messages": []})
        emit({"type": "agent_settled"})
        return
    if write:
        emit({"type": "tool_execution_start", "toolCallId": "t1", "toolName": "write", "args": {"path": target}})
        d = os.path.dirname(target)
        if d:
            os.makedirs(d, exist_ok=True)
        with open(target, "w") as f:
            f.write(f"hello from fake pi, run {n} {note}\n")
        emit({"type": "tool_execution_end", "toolCallId": "t1", "toolName": "write",
              "result": {"content": [], "details": {}}, "isError": False})
    text = f"Wrote {target}" if write else "Skipped"
    if mode == "textq" and n == 1:
        text = "Which database should I use?"
    emit({"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": text}]}})
    emit({"type": "turn_end"})
    emit({"type": "agent_end", "messages": []})
    if mode != "nosettled":
        emit({"type": "agent_settled"})


for line in sys.stdin:
    try:
        cmd = json.loads(line)
    except ValueError:
        continue
    t = cmd.get("type")
    resp = {"type": "response", "command": t, "success": True}
    if "id" in cmd:
        resp["id"] = cmd["id"]
    if t == "get_available_models":
        resp["data"] = {"models": [{"provider": "local", "id": "fake-model"}]}
    elif t == "get_commands":
        resp["data"] = {"commands": [{"name": "fake"}]}
    elif t == "extension_ui_response":
        answers.put(cmd)
        continue
    elif t == "abort":
        aborted.set()
    emit(resp)
    if t in ("prompt", "follow_up"):
        runs += 1
        threading.Thread(target=flow, args=(runs, cmd.get("message")), daemon=True).start()
