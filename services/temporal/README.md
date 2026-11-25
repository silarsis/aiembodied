# Temporal server

The workflow engine behind the avatars' sense of time (see `../workflows`). It is the stock
[Temporal CLI](https://github.com/temporalio/cli) dev server (`temporal server start-dev`) with its state in a SQLite
file. It listens on `127.0.0.1` only, and the app starts and stops it with everything else. There is nothing of ours
in this folder except the start script.

## Run

```powershell
.\scripts\start.ps1                 # gRPC 127.0.0.1:7233, UI http://127.0.0.1:8233
.\scripts\start.ps1 -Port 7300 -UiPort 8300
```

It runs in the foreground. On the first run it downloads the pinned CLI (v1.10.1, `temporal_cli_1.10.1_windows_amd64.zip`
from the temporalio/cli GitHub release), checks the zip's SHA-256 against that release's `checksums.txt` (and stops if it
does not match), and unpacks `temporal.exe` into `%LOCALAPPDATA%\aiembodied\bin\`.

It starts the server with:

- namespace `aiembodied`;
- search attributes `AgentId`, `Owner`, `Purpose` and `Flow` (all Keyword), which the workflows set so plans can be listed
  per avatar. The namespace and attributes are passed on every start; that is harmless when they already exist;
- `--log-level warn --log-format pretty`, so the server's own log stays short and readable.

## Settings

| Variable | Default | |
|---|---|---|
| `TEMPORAL_EXE` | `%LOCALAPPDATA%\aiembodied\bin\temporal.exe` | where to find (or install) the CLI |
| `TEMPORAL_DB` | `%LOCALAPPDATA%\aiembodied\temporal\temporal.db` | the SQLite file (the folder is created) |

`-Port`, `-UiPort` and `-DbFile` override the ports and the file for one run.

## Look inside

Open http://127.0.0.1:8233 for the Temporal UI: running workflows (`life:<avatar>`, `remind:...`, `watch:...`, `flow:...`),
their history, and Schedules (`sched:<avatar>:<name>`). Search by `AgentId`, `Purpose`, `Owner` or `Flow`.

To start over, stop the server and delete the SQLite file.
