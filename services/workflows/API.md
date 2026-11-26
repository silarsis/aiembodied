# Workflows API

JSON over HTTP on `127.0.0.1:8198`. Errors are `{"detail": ...}`. A bad body or definition is 422 with
`{"detail": {"errors": ["steps[2].wait: ..."]}}`; 404 for something that is not there; 503 while Temporal is not
reachable; 502 when the memory engine fails. Times are ISO 8601 with `Z`. `avatarId` is the app's avatar id (`echo`,
`sage`, ...). When `WORKFLOWS_API_TOKEN` is set, every `/v1` route needs `Authorization: Bearer <token>`.

## `GET /health`

`{"ok": true, "version": "0.1.0", "temporal": true, "namespace": "aiembodied", "agentLife": true, "agents": ["echo"]}`.
Always 200 while the process runs; `temporal` is false while it cannot reach the server.

## Agents

- `PUT /v1/agents` body `{"agents": [{"id": "echo", "name": "Echo"}]}`: starts `life:<id>` for each avatar that has none
  (when `AGENT_LIFE` is on) and cancels life workflows of avatars no longer listed. The list is kept and applied again
  when Temporal comes back. Returns `{"agents": [...], "started": [...], "stopped": [...]}`.
- `GET /v1/agents/{avatarId}/life`: `{"awake": true, "awakeSeconds": 5400, "nextDecisionAt": "...Z" | null,
  "lastDecision": {"at": "...Z", "summary": "SAY \"...\""} | null, "mood": null, "lastPlanDate": "2026-11-26" | null,
  "lastReflectDate": null, "paused": false}`. 404 when no life workflow runs. (`mood` is always null for now.)
- `POST /v1/agents/{avatarId}/sleep` `{"reason": "tired"}` and `POST /v1/agents/{avatarId}/wake`: signals to the life workflow.

## Reminders, wake-ups, watches

- `POST /v1/reminders` `{"avatarId", "at": ISO | "inSeconds": n, "text", "alarm": false}` -> `{"workflowId": "remind:<uuid>",
  "intentionId", "dueAt"}`. At the time it says "Reminder: <text>" (always urgent, so it is spoken at once; `alarm` is kept but no longer changes anything); more than 10 minutes late it adds
  "(this was due at HH:MM)". If the app is closed it waits for it, up to 7 days.
- `POST /v1/wakeups` `{"avatarId", "at"|"inSeconds", "note"}` -> the same shape (`wake:<uuid>`). At the time the avatar
  thinks about the note with its safe tools, and says something if it answers `SAY: ...`.
- `POST /v1/watches` `{"avatarId", "condition", "then", "untilHours": 24}` -> `{"workflowId": "watch:<uuid>", "intentionId"}`.
  `untilHours` defaults to 24 and is at most 720. The watch ends after it fires once, or at the deadline.

`condition` is one of:

```json
{"kind": "entity", "entityId": "binary_sensor.front_door", "state": "on"}
{"kind": "entity", "entityId": "sensor.washer_power", "below": 5, "forSeconds": 180}
{"kind": "search", "query": "...", "everyMinutes": 60}
{"kind": "service", "url": "http://...", "everyMinutes": 5}
{"kind": "coding_task", "taskId": "..."}
```

(`above` works like `below`. Entity watches follow `home.change` and `home.alert` events and also poll memory's
`/v1/home/entities` every 5 minutes. A search watch fires on a result it did not see the first time; a service watch
fires when the address gives no 2xx or 3xx answer.) `then` is `{"say": "text"}`, `{"think": "prompt"}` or
`{"flow": "<name>", "inputs": {...}}`.

## Flows

- `GET /v1/flows?avatarId=` -> `{"flows": [...]}` (from memory). `GET /v1/flows/{avatarId}/{name}` -> the flow, or 404.
- `PUT /v1/flows/{avatarId}/{name}` `{"description", "definition": {"inputs": {...}, "steps": [...]}, "trigger", "enabled": true}`.
  The definition is validated first (422 with the list of errors). It is saved to memory as a new version, then the
  trigger is applied: `schedule` creates or updates the Temporal Schedule `sched:<avatar>:<name>` (overlap skip, catch-up
  window 10 minutes); `watch` (re)starts `flowwatch:<avatar>:<name>`; `manual` removes any schedule or watcher. Returns the
  saved flow plus `"triggerApplied": false` if Temporal was down (the reconcile pass applies it later).
- `POST /v1/flows/{avatarId}/{name}/run` `{"inputs": {...}}` -> `{"workflowId": "flow:<avatar>:<name>:<uuid>"}`.
- `DELETE /v1/flows/{avatarId}/{name}`: disables the flow in memory and removes its schedule or watcher.

Triggers: `{"kind": "manual"}`, `{"kind": "schedule", "cron": "30 7 * * 1-5"}`, `{"kind": "schedule", "everyMinutes": 60}`,
`{"kind": "watch", "condition": {...}}`.

Steps. Each is an object with one step key and an optional `"as": "var"`. `{{name}}` in any string becomes the variable
(inputs plus earlier `as` results); an unknown name becomes empty text.

| Step | Result |
|---|---|
| `{"think": "prompt", "tools": false}` | the reply text |
| `{"choose": "question", "options": ["a", "b"]}` | one option (the first when the answer is unclear) |
| `{"recall": "query"}` | text of the top memory results |
| `{"remember": "fact"}` | saves a fact for the avatar |
| `{"search": "query"}` | text of the top web results |
| `{"tool": "toolName", "params": {...}}` | the tool result as JSON text |
| `{"say": "text", "urgent": false}` | |
| `{"ask": "question"}` | "yes" or "no" |
| `{"wait": {"seconds": 600}}` or `{"wait": {"until": "07:30"}}` | waits (until the next local time, or an ISO time) |
| `{"wait_for": {"entityId": "...", "state": "on"} \| {"signal": "name"}, "timeoutSeconds": 3600}` | "ok" or "timeout" |
| `{"if": {"var": "x", "op": "eq", "value": 1}, "then": [...], "else": [...]}` | ops: eq, ne, contains, gt, lt, truthy, falsy |
| `{"repeat": {"times": 3} \| {"until": {cond}}, "steps": [...]}` | the variable `round` counts from 1; at most 1000 rounds |
| `{"run_flow": "name", "inputs": {...}}` | the child flow's last result; nesting at most 5 deep |
| `{"set_intention": "text", "kind": "intention"}` | `kind` is goal, intention or promise |

Limits: names `[a-z0-9_-]{1,64}`, nesting at most 6 deep, at most 200 steps in total, at most 1000 executed steps per run. A
flow whose own trigger starts it again within a minute is stopped (the schedule is paused, or the watcher ends and the
flow is disabled) and an intention note is written.

## Intentions and plans

- `POST /v1/intentions` `{"avatarId", "kind": "goal"|"intention"|"promise", "text", "why", "dueAt", "parentId"}` -> the memory row.
  No workflow is started.
- `GET /v1/plans?avatarId=` -> `{"workflows": [{"workflowId", "purpose", "title", "status", "startedAt", "nextAt"}],
  "intentions": [open rows from memory], "flows": [{"name", "trigger", "enabled", "lastRun"}]}`. Running workflows come from
  Temporal's visibility by `AgentId`; the life workflow is left out.
- `POST /v1/plans/{workflowId}/signal` `{"signal": "pause"|"resume"|"snooze"|"note", "args": {...}}`. `snooze` takes
  `{"seconds": n}`, `note` takes `{"text": "..."}`. A `sched:` id only accepts pause and resume.
- `DELETE /v1/plans/{workflowId}?why=`: cancels the workflow (deletes the schedule for `sched:` ids) and marks its
  intention dropped with the reason.
