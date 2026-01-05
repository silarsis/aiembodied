# Plugin/Tool System Design

> **Priority**: High  
> **Status**: Design Draft  
> **Last Updated**: 2026-01-05

## Overview

Enable the Embodied ChatGPT Assistant to execute actions beyond conversation by integrating with external tools and services. The primary target is **Home Assistant via MCP (Model Context Protocol)**, allowing voice-driven smart home control.

## Goals

1. **Extensible Architecture** - Plugin system that can accommodate various tool sources
2. **Home Assistant Integration** - First-class support via MCP server protocol
3. **Voice-First UX** - Natural language commands translated to tool calls
4. **Secure Execution** - User consent, confirmation for destructive actions, audit logging
5. **Offline Resilience** - Graceful degradation when tools are unavailable

## Architecture

### High-Level Flow

```
User Voice ──► Realtime API ──► Tool Call Decision ──► Plugin Router
                                                            │
                    ┌───────────────────────────────────────┤
                    ▼                   ▼                   ▼
            Home Assistant MCP    Local Plugins     Future MCPs
                    │                   │                   │
                    ▼                   ▼                   ▼
             Smart Devices        System Actions      Third-party
```

### Component Breakdown

#### 1. Tool Registry (Main Process)

```typescript
interface Tool {
  id: string;
  name: string;
  description: string;          // Shown to LLM for tool selection
  parameters: JSONSchema;       // Function call schema
  source: 'mcp' | 'builtin' | 'custom';
  mcpServer?: string;           // If from MCP, which server
  requiresConfirmation?: boolean;
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}

interface ToolRegistry {
  register(tool: Tool): void;
  unregister(id: string): void;
  list(): Tool[];
  get(id: string): Tool | undefined;
  executeById(id: string, params: Record<string, unknown>): Promise<ToolResult>;
}
```

#### 2. MCP Client (Main Process)

Connects to Home Assistant's MCP Server to discover and invoke tools.

```typescript
interface MCPClient {
  connect(url: string, token: string): Promise<void>;
  disconnect(): void;
  discoverTools(): Promise<MCPTool[]>;
  callTool(name: string, arguments: Record<string, unknown>): Promise<MCPResult>;
  onToolsChanged(callback: () => void): void;
}
```

**Connection Details:**
- Home Assistant exposes MCP via SSE (Server-Sent Events) at `http://<ha-host>:8123/api/mcp`
- Requires Long-Lived Access Token for authentication
- Tool discovery happens at connection and on `tools/list_changed` notifications

#### 3. Tool Execution Bridge (IPC)

Expose tool capabilities to the renderer/realtime session:

```typescript
// Preload API additions
interface ToolBridge {
  listAvailableTools(): Promise<ToolSummary[]>;
  executeTool(toolId: string, params: unknown): Promise<ToolResult>;
  onToolResult(callback: (result: ToolExecutionEvent) => void): void;
}
```

#### 4. Realtime API Integration

OpenAI's Realtime API supports function calling. The flow:

1. **Session Setup**: Inject tool definitions into session `instructions` or use native function calling
2. **Tool Selection**: LLM decides to call a tool based on user intent
3. **Execution**: Main process executes via registry, returns result
4. **Response Continuation**: LLM incorporates result and responds vocally

```typescript
// Session config extension
interface SessionToolConfig {
  tools: Array<{
    type: 'function';
    name: string;
    description: string;
    parameters: JSONSchema;
  }>;
  tool_choice?: 'auto' | 'required' | 'none';
}
```

## Home Assistant MCP Integration

### Configuration

```typescript
interface HomeAssistantConfig {
  url: string;                  // e.g., "http://192.168.1.100:8123"
  accessToken: string;          // Long-lived access token
  exposedDomains?: string[];    // e.g., ["light", "switch", "climate"]
  requireConfirmation?: string[]; // Domains needing user OK
}
```

### Available Tool Categories (from HA MCP)

| Domain | Example Actions |
|--------|-----------------|
| `light` | Turn on/off, set brightness, change color |
| `switch` | Toggle on/off |
| `climate` | Set temperature, change HVAC mode |
| `cover` | Open/close blinds, garage doors |
| `scene` | Activate scenes |
| `automation` | Trigger automations |
| `media_player` | Play/pause, volume, source selection |
| `lock` | Lock/unlock (high confirmation) |

### Example Voice Interactions

```
User: "Turn off the living room lights"
→ Tool call: homeassistant.light.turn_off({ entity_id: "light.living_room" })
→ Response: "Done, I've turned off the living room lights."

User: "What's the temperature in the bedroom?"
→ Tool call: homeassistant.climate.get_state({ entity_id: "climate.bedroom" })
→ Response: "The bedroom is currently at 22 degrees."

User: "Set movie mode"
→ Tool call: homeassistant.scene.turn_on({ entity_id: "scene.movie_mode" })
→ Response: "Movie mode activated. Enjoy!"
```

## Built-in Plugins (Non-MCP)

### System Actions

```typescript
const builtinTools: Tool[] = [
  {
    id: 'system.volume',
    name: 'Set System Volume',
    description: 'Adjust the computer speaker volume',
    parameters: { level: { type: 'number', min: 0, max: 100 } },
    execute: async ({ level }) => setSystemVolume(level)
  },
  {
    id: 'system.notification',
    name: 'Show Notification',
    description: 'Display a desktop notification',
    parameters: { title: 'string', message: 'string' },
    execute: async ({ title, message }) => showNotification(title, message)
  },
  {
    id: 'system.clipboard.read',
    name: 'Read Clipboard',
    description: 'Read current clipboard text content',
    execute: async () => clipboard.readText()
  }
];
```

### Timer/Reminder Actions

```typescript
{
  id: 'timer.set',
  name: 'Set Timer',
  description: 'Set a countdown timer that will alert when finished',
  parameters: { 
    duration_minutes: 'number',
    label?: 'string'
  },
  execute: async ({ duration_minutes, label }) => timerService.create(duration_minutes, label)
}
```

## Security Considerations

### Confirmation Levels

| Level | When | UX |
|-------|------|----|
| **None** | Read-only queries | Silent execution |
| **Notify** | Safe mutations (lights) | TTS confirmation after |
| **Confirm** | Sensitive actions (locks, payments) | Require verbal "yes" |
| **Block** | Dangerous operations | Disabled by policy |

### Audit Logging

```typescript
interface ToolExecutionLog {
  timestamp: Date;
  toolId: string;
  parameters: Record<string, unknown>;
  result: 'success' | 'error' | 'cancelled';
  durationMs: number;
  triggeredBy: 'voice' | 'automation';
}
```

## Database Schema Additions

```sql
-- MCP server configurations
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  token_encrypted TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  last_connected_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Custom tool overrides (names, confirmations)
CREATE TABLE tool_overrides (
  tool_id TEXT PRIMARY KEY,
  custom_name TEXT,
  confirmation_level TEXT,
  enabled INTEGER DEFAULT 1
);

-- Execution audit log
CREATE TABLE tool_executions (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  params_json TEXT,
  result TEXT,
  error_message TEXT,
  duration_ms INTEGER,
  triggered_by TEXT,
  executed_at INTEGER NOT NULL
);
```

## UI Additions

### Settings Panel: Integrations Tab

```
┌─────────────────────────────────────────────────────────┐
│ Integrations                                             │
├─────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────┐ │
│ │ 🏠 Home Assistant                      [Connected ●] │ │
│ │    http://192.168.1.100:8123                        │ │
│ │    23 tools available                               │ │
│ │    [Configure] [Disconnect]                         │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ [+ Add Integration]                                     │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ Available Tools                              [Filter ▾] │
│ ─────────────────────────────────────────────────────── │
│ ☑ light.turn_on          Confirmation: None            │
│ ☑ light.turn_off         Confirmation: None            │
│ ☑ lock.lock              Confirmation: Required        │
│ ☐ script.dangerous_one   [Disabled]                    │
│ ...                                                     │
└─────────────────────────────────────────────────────────┘
```

## Implementation Phases

### Phase 1: Foundation
- [ ] Create `ToolRegistry` in main process
- [ ] Add IPC bridge for tool listing/execution
- [ ] Implement basic built-in tools (clipboard, notifications)
- [ ] Add tool UI in settings panel

### Phase 2: Home Assistant MCP
- [ ] Implement `MCPClient` with SSE transport
- [ ] Add HA configuration UI
- [ ] Tool discovery and registration from HA
- [ ] Confirmation flow for sensitive actions

### Phase 3: Realtime Integration
- [ ] Inject tools into Realtime API session
- [ ] Handle function call responses
- [ ] Voice confirmation for high-risk actions
- [ ] Result vocalization

### Phase 4: Polish
- [ ] Audit logging and history view
- [ ] Tool favorites and voice shortcuts
- [ ] Error recovery and retry logic
- [ ] Documentation for adding custom plugins

## Open Questions

1. **Tool caching**: How long to cache HA entity states before re-querying?
2. **Rate limiting**: Should we limit tool calls per minute to prevent abuse?
3. **Multi-step actions**: Support for chained tool calls (e.g., "Turn off all lights and lock the doors")?
4. **Local LLM fallback**: If Realtime API is down, can we route tool decisions to a local model?

## References

- [Home Assistant MCP Server Integration](https://www.home-assistant.io/integrations/mcp_server)
- [OpenAI Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Model Context Protocol Specification](https://spec.modelcontextprotocol.io/)
