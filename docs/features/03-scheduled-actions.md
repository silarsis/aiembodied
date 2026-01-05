# Scheduled Actions Design

> **Priority**: Medium  
> **Status**: Design Draft  
> **Last Updated**: 2026-01-05

## Overview

Enable the assistant to perform **time-based actions**: proactive greetings, reminders, scheduled announcements, and recurring routines. This transforms the assistant from purely reactive to an active presence that can initiate interactions.

## Goals

1. **Reminders** - User-set alerts with voice notification at specified times
2. **Scheduled Greetings** - "Good morning" routines at configurable times
3. **Recurring Tasks** - Daily/weekly actions (weather, calendar summary)
4. **Tool Triggers** - Execute plugin/tool actions on schedule (e.g., "At sunset, dim the lights")
5. **Natural Language Scheduling** - "Remind me in 30 minutes" style commands

## Use Cases

| Scenario | Trigger | Action |
|----------|---------|--------|
| Morning routine | 7:00 AM weekdays | "Good morning! Today's weather is..." |
| Hydration reminder | Every 2 hours | "Time for a water break!" |
| Meeting prep | 5 min before calendar event | "Your standup starts in 5 minutes" |
| Evening wind-down | Sunset | Dim lights, play relaxing music |
| Weekly summary | Sunday 6 PM | "Here's what you accomplished this week" |

## Data Model

### Schedule Schema

```typescript
interface ScheduledAction {
  id: string;                    // UUID
  name: string;                  // User-friendly name
  enabled: boolean;
  
  // Timing
  schedule: ScheduleDefinition;
  
  // What to do
  actionType: 'speak' | 'tool' | 'routine';
  payload: SpeakPayload | ToolPayload | RoutinePayload;
  
  // Conditions (optional)
  conditions?: ActionCondition[];
  
  // Metadata
  personaId?: string;            // Use specific persona, or null for active
  lastTriggeredAt?: Date;
  nextTriggerAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

type ScheduleDefinition = 
  | { type: 'once'; at: Date }
  | { type: 'recurring'; cron: string; timezone: string }
  | { type: 'interval'; everyMinutes: number; startAt?: Date }
  | { type: 'relative'; inMinutes: number }  // "In 30 minutes"
  | { type: 'event'; source: 'sunrise' | 'sunset' | 'calendar'; offset?: number };

interface SpeakPayload {
  text: string;                  // What to say
  interruptible?: boolean;       // Can user respond or just announcement?
}

interface ToolPayload {
  toolId: string;                // From plugin registry
  params: Record<string, unknown>;
}

interface RoutinePayload {
  steps: Array<SpeakPayload | ToolPayload>;
  delayBetweenMs?: number;
}

interface ActionCondition {
  type: 'presence' | 'state' | 'time_window';
  // e.g., only if user has been active in last 5 min
  config: Record<string, unknown>;
}
```

### Database Schema

```sql
CREATE TABLE scheduled_actions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  
  -- Schedule definition (JSON)
  schedule_type TEXT NOT NULL,
  schedule_config TEXT NOT NULL,  -- JSON
  
  -- Action definition
  action_type TEXT NOT NULL,      -- 'speak', 'tool', 'routine'
  action_payload TEXT NOT NULL,   -- JSON
  
  -- Optional conditions
  conditions TEXT,                -- JSON array
  
  -- Persona binding
  persona_id TEXT REFERENCES personas(id),
  
  -- Metadata
  last_triggered_at INTEGER,
  next_trigger_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_scheduled_next ON scheduled_actions(next_trigger_at)
  WHERE enabled = 1;
```

## Architecture

### Scheduler Service (Main Process)

```typescript
class SchedulerService {
  private timer: NodeJS.Timeout | null = null;
  private queue: PriorityQueue<ScheduledAction>;
  
  constructor(
    private db: MemoryStore,
    private toolRegistry: ToolRegistry,
    private speechBridge: SpeechBridge
  ) {}
  
  async start(): Promise<void> {
    await this.loadScheduledActions();
    this.scheduleNextTick();
  }
  
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
  }
  
  private scheduleNextTick(): void {
    const next = this.queue.peek();
    if (!next) return;
    
    const delay = next.nextTriggerAt.getTime() - Date.now();
    this.timer = setTimeout(() => this.executeNext(), Math.max(0, delay));
  }
  
  private async executeNext(): Promise<void> {
    const action = this.queue.pop();
    if (!action || !this.checkConditions(action)) {
      this.scheduleNextTick();
      return;
    }
    
    await this.executeAction(action);
    
    // Reschedule if recurring
    if (action.schedule.type !== 'once' && action.schedule.type !== 'relative') {
      action.nextTriggerAt = this.calculateNextTrigger(action.schedule);
      this.queue.push(action);
      await this.db.updateScheduledAction(action);
    }
    
    this.scheduleNextTick();
  }
  
  private async executeAction(action: ScheduledAction): Promise<void> {
    switch (action.actionType) {
      case 'speak':
        await this.speechBridge.speak(action.payload.text);
        break;
      case 'tool':
        await this.toolRegistry.executeById(
          action.payload.toolId,
          action.payload.params
        );
        break;
      case 'routine':
        for (const step of action.payload.steps) {
          await this.executeStep(step);
          if (action.payload.delayBetweenMs) {
            await sleep(action.payload.delayBetweenMs);
          }
        }
        break;
    }
  }
}
```

### Component Flow

```
┌─────────────────────────────────────────────────────────┐
│                   SchedulerService                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │ Priority    │  │ Cron        │  │ Condition   │     │
│  │ Queue       │  │ Parser      │  │ Evaluator   │     │
│  └──────┬──────┘  └─────────────┘  └─────────────┘     │
│         │                                               │
│         ▼ (when time arrives)                          │
│  ┌─────────────────────────────────────────────────┐   │
│  │                ActionExecutor                     │   │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────────────┐  │   │
│  │  │ Speak   │  │ Tool    │  │ Routine         │  │   │
│  │  │ Handler │  │ Handler │  │ Handler         │  │   │
│  │  └────┬────┘  └────┬────┘  └───────┬─────────┘  │   │
│  └───────┼────────────┼───────────────┼────────────┘   │
└──────────┼────────────┼───────────────┼─────────────────┘
           │            │               │
           ▼            ▼               ▼
    ┌──────────┐  ┌──────────────┐  ┌──────────────┐
    │ Speech   │  │ Tool         │  │ Multi-step   │
    │ via IPC  │  │ Registry     │  │ Execution    │
    └──────────┘  └──────────────┘  └──────────────┘
```

## Voice Commands for Scheduling

### Natural Language Parsing

| User says | Parsed action |
|-----------|---------------|
| "Remind me in 30 minutes to take a break" | Relative: +30min, speak: "Time to take a break" |
| "Set an alarm for 7 AM" | Once: 7:00 next occurrence |
| "Every day at 9, tell me the weather" | Cron: `0 9 * * *`, tool: weather |
| "At sunset, turn off the garden lights" | Event: sunset, tool: light.turn_off |
| "Cancel my morning reminder" | Delete: match by name |

### Recognition Examples

```typescript
const SCHEDULE_PATTERNS = [
  // Relative time
  { pattern: /in (\d+) (minute|hour|day)s?/i, type: 'relative' },
  // Specific time
  { pattern: /at (\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/i, type: 'time' },
  // Recurring
  { pattern: /every (day|morning|evening|week)/i, type: 'recurring' },
  // Event-based
  { pattern: /(sunrise|sunset)/i, type: 'event' },
];
```

## Prebuilt Routines

### Morning Routine Template

```typescript
const MORNING_ROUTINE: RoutinePayload = {
  steps: [
    { type: 'speak', text: 'Good morning! Here\'s your briefing for today.' },
    { type: 'tool', toolId: 'weather.today', params: {} },
    { type: 'speak', text: 'Let me check your calendar.' },
    { type: 'tool', toolId: 'calendar.today', params: {} },
    { type: 'speak', text: 'Have a great day!' }
  ],
  delayBetweenMs: 1500
};
```

### Evening Wind-Down Template

```typescript
const EVENING_ROUTINE: RoutinePayload = {
  steps: [
    { type: 'speak', text: 'Time to wind down for the evening.' },
    { type: 'tool', toolId: 'homeassistant.scene.turn_on', params: { scene: 'evening' } },
    { type: 'speak', text: 'The relaxing lights are on. Would you like some music?' }
  ]
};
```

## UI Design

### Schedules Panel (Settings)

```
┌─────────────────────────────────────────────────────────┐
│ Scheduled Actions                        [+ Add New]    │
├─────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────┐ │
│ │ ☑ Morning Briefing                                  │ │
│ │   🕐 7:00 AM daily          Next: Tomorrow 7:00 AM  │ │
│ │   📣 Weather + Calendar summary                     │ │
│ │   [Edit] [Run Now]                                  │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ ☑ Hydration Reminder                                │ │
│ │   🔁 Every 2 hours          Next: 2:30 PM           │ │
│ │   💧 "Time for a water break!"                      │ │
│ │   [Edit] [Run Now]                                  │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ ☐ Sunset Lights (disabled)                          │ │
│ │   🌅 At sunset              Last: Yesterday 5:47 PM │ │
│ │   💡 Dim living room to 30%                         │ │
│ │   [Edit] [Enable]                                   │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ Pending Reminders                                       │
│ ─────────────────────────────────────────────────────── │
│ • "Call mom" in 15 minutes                    [Cancel] │
│ • "Take medicine" at 8:00 PM                  [Cancel] │
└─────────────────────────────────────────────────────────┘
```

### Schedule Editor

```
┌─────────────────────────────────────────────────────────┐
│ Edit Schedule: Morning Briefing                         │
├─────────────────────────────────────────────────────────┤
│ Name: [Morning Briefing                              ]  │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ When                                                    │
│ ─────────────────────────────────────────────────────── │
│ ○ Once at: [date picker]                               │
│ ● Daily at: [7:00 AM ▾]                                │
│ ○ Every X hours: [ ] hours                             │
│ ○ Event-based: [sunrise/sunset ▾] offset: [+/- min]    │
│ ○ Custom cron: [________]                              │
│                                                         │
│ Timezone: [System Default ▾]                           │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ Days Active                                             │
│ ─────────────────────────────────────────────────────── │
│ [✓] Mon  [✓] Tue  [✓] Wed  [✓] Thu  [✓] Fri            │
│ [✓] Sat  [✓] Sun                                       │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ Action                                                  │
│ ─────────────────────────────────────────────────────── │
│ ● Speak: [Good morning! Here's your update...]         │
│ ○ Run tool: [Select tool ▾]                            │
│ ○ Routine: [Select routine ▾]                          │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ Conditions (Optional)                                   │
│ ─────────────────────────────────────────────────────── │
│ ☐ Only if user has been active in last [5] minutes     │
│ ☐ Only if Home Assistant state: [Select entity ▾]      │
│                                                         │
│ [Cancel]                                      [Save]    │
└─────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Core Scheduler
- [ ] Create `SchedulerService` in main process
- [ ] Add `scheduled_actions` table and migrations
- [ ] Priority queue with next-trigger ordering
- [ ] Basic "speak" action execution

### Phase 2: Voice Scheduling
- [ ] Natural language time parsing
- [ ] "Remind me in X" command handling
- [ ] Reminder confirmation and cancellation

### Phase 3: Recurring Schedules
- [ ] Cron expression parsing (node-cron or similar)
- [ ] Day-of-week filtering
- [ ] Timezone handling

### Phase 4: Tool Integration
- [ ] Execute tool actions on schedule
- [ ] Routine (multi-step) execution
- [ ] Sunset/sunrise event triggers (via API or HA integration)

### Phase 5: Conditions & Polish
- [ ] User presence detection
- [ ] State-based conditions
- [ ] Schedule history and logging
- [ ] Settings UI

## Dependencies

- **node-cron** or **croner** - Cron expression parsing
- **luxon** or **date-fns** - Timezone-aware date handling
- **sunrise-sunset-js** - Calculate sunrise/sunset (or use HA)

## Open Questions

1. **Presence detection**: How to know if user is present? Webcam? Motion sensor via HA?
2. **Do Not Disturb**: Should there be quiet hours where no proactive speech occurs?
3. **Missed schedules**: If app was closed during a scheduled time, run on startup?
4. **Calendar integration**: Direct Google/Outlook calendar access or via HA?
5. **Snooze**: Allow "Snooze this reminder for 10 minutes"?

## References

- [Cron Expression Format](https://crontab.guru/)
- [Sunrise/Sunset API](https://sunrise-sunset.org/api)
- Existing timer handling (if any) in the codebase
