# Custom Voice Personas Design

> **Priority**: Medium  
> **Status**: Design Draft  
> **Last Updated**: 2026-01-05

## Overview

Allow users to create and switch between multiple **assistant personas**, each with its own voice, personality, instructions, and optionally separate conversation memory. This transforms the assistant from a single-purpose tool into a cast of characters for different contexts.

## Goals

1. **Persona Customization** - Name, voice, avatar, system instructions per persona
2. **Quick Switching** - Voice command or UI toggle to swap active persona
3. **Isolated or Shared Memory** - Option to keep conversations separate per persona
4. **Avatar Binding** - Each persona can have its own VRM model or face configuration
5. **Wake Word Flexibility** - Optional different wake words per persona

## Use Cases

| Persona | Voice | Purpose |
|---------|-------|---------|
| **Default Assistant** | Alloy | General help, casual conversation |
| **Work Mode** | Echo | Professional tone, meeting reminders, work app integration |
| **Storyteller** | Fable | Bedtime stories, creative writing for kids |
| **Home Control** | Onyx | Terse, efficient smart home commands |
| **Language Tutor** | Shimmer | Patient, educational, speaks target language |

## Data Model

### Persona Schema

```typescript
interface Persona {
  id: string;                    // UUID
  name: string;                  // Display name: "Jarvis", "Luna", etc.
  slug: string;                  // URL-safe identifier
  
  // Voice configuration
  voice: OpenAIVoice;            // alloy, echo, fable, onyx, nova, shimmer
  speechStyle?: string;          // Additional voice guidance in instructions
  
  // Personality
  systemInstructions: string;    // Base system prompt
  personalityTraits?: string[];  // e.g., ["formal", "concise", "humorous"]
  
  // Avatar binding
  avatarType: 'default' | 'vrm' | 'custom';
  vrmModelId?: string;           // Link to vrm_models table
  faceConfigId?: string;         // Link to generated face config
  
  // Memory behavior
  memoryMode: 'shared' | 'isolated';
  sessionPrefix?: string;        // Prepended to session IDs if isolated
  
  // Wake word (optional)
  wakeWord?: {
    keyword: string;             // "Hey Luna", "OK Computer"
    modelPath?: string;          // Custom Porcupine .ppn file
    sensitivity?: number;
  };
  
  // Metadata
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}
```

### Database Schema

```sql
CREATE TABLE personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  voice TEXT NOT NULL DEFAULT 'alloy',
  speech_style TEXT,
  system_instructions TEXT NOT NULL,
  personality_traits TEXT,       -- JSON array
  avatar_type TEXT DEFAULT 'default',
  vrm_model_id TEXT REFERENCES vrm_models(id),
  face_config_id TEXT,
  memory_mode TEXT DEFAULT 'shared',
  session_prefix TEXT,
  wake_word_keyword TEXT,
  wake_word_model_path TEXT,
  wake_word_sensitivity REAL,
  is_default INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Index for quick lookup by slug
CREATE INDEX idx_personas_slug ON personas(slug);
```

## Architecture

### Component Integration

```
┌─────────────────────────────────────────────────────────┐
│                    PersonaManager                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │ Create      │  │ Switch      │  │ Delete      │     │
│  │ Update      │  │ GetActive   │  │ Import/     │     │
│  │ List        │  │ SetDefault  │  │ Export      │     │
│  └─────────────┘  └─────────────┘  └─────────────┘     │
└─────────────────────────────┬───────────────────────────┘
                              │
         ┌────────────────────┼────────────────────┐
         ▼                    ▼                    ▼
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│ RealtimeClient  │  │ WakeWordService │  │ AvatarRenderer  │
│ • Apply voice   │  │ • Load custom   │  │ • Load bound    │
│ • Set instruct- │  │   wake word     │  │   VRM model     │
│   ions          │  │ • Switch active │  │ • Apply face    │
└─────────────────┘  │   keyword       │  │   config        │
                     └─────────────────┘  └─────────────────┘
```

### Switching Flow

```
1. User says "Switch to Luna" or taps persona in UI
                │
                ▼
2. PersonaManager.setActive(personaId)
                │
                ▼
3. Parallel updates:
   ├─► RealtimeClient.updateSessionConfig({ voice, instructions })
   ├─► AvatarRenderer.loadPersonaAvatar(persona.vrmModelId)
   ├─► WakeWordService.setActiveKeyword(persona.wakeWord)
   └─► MemoryStore.setContext({ personaId, sessionPrefix })
                │
                ▼
4. Confirmation TTS: "Luna here. How can I help?"
```

## UI Design

### Persona Selector (Main Window)

Quick access dropdown or carousel in the status bar:

```
┌────────────────────────────────────────────┐
│ 🎭 Active: Luna ▾                          │
├────────────────────────────────────────────┤
│ ○ Default Assistant (Alloy)                │
│ ● Luna (Shimmer) ✓                         │
│ ○ Work Mode (Echo)                         │
│ ○ Storyteller (Fable)                      │
│ ──────────────────────────────────         │
│ [+ Create New Persona]                     │
└────────────────────────────────────────────┘
```

### Persona Editor (Settings)

```
┌─────────────────────────────────────────────────────────┐
│ Edit Persona: Luna                           [Delete]   │
├─────────────────────────────────────────────────────────┤
│ Name: [Luna                                           ] │
│                                                         │
│ Voice: [Shimmer ▾]    🔊 [Preview]                     │
│                                                         │
│ Speech Style:                                           │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Speak warmly and patiently. Use encouraging         │ │
│ │ language. Comfortable with silence.                 │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ System Instructions:                                    │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ You are Luna, a calm and thoughtful assistant.      │ │
│ │ You help with creative projects and brainstorming.  │ │
│ │ You ask clarifying questions before diving in.      │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ Avatar Binding                                          │
│ ─────────────────────────────────────────────────────── │
│ ○ Use default avatar                                    │
│ ● Use VRM model: [Luna_v2.vrm ▾]                       │
│ ○ Generate face from description                       │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ Wake Word (Optional)                                    │
│ ─────────────────────────────────────────────────────── │
│ ☑ Enable custom wake word                              │
│ Keyword: [Hey Luna      ]                              │
│ Model: [Browse .ppn file]                              │
│                                                         │
│ ─────────────────────────────────────────────────────── │
│ Memory                                                  │
│ ─────────────────────────────────────────────────────── │
│ ● Share conversation history with all personas         │
│ ○ Isolated memory (Luna has her own history)           │
│                                                         │
│ [Cancel]                                     [Save]     │
└─────────────────────────────────────────────────────────┘
```

## Voice Commands

| Command | Action |
|---------|--------|
| "Switch to Luna" | Activate persona by name |
| "Who am I talking to?" | Announce active persona |
| "Create a new persona called Chef" | Start persona creation flow |
| "Use your normal voice" | Switch to default persona |
| "Forget this conversation" | Clear isolated memory for current persona |

## Implementation Phases

### Phase 1: Core Persona Model
- [ ] Add `personas` table and migrations
- [ ] Create `PersonaManager` service in main process
- [ ] IPC bridges for CRUD operations
- [ ] Basic settings UI for creating personas
- [ ] Voice/instructions binding

### Phase 2: Switching Integration
- [ ] Realtime client voice/instructions update on switch
- [ ] Active persona persistence across restarts
- [ ] Voice command recognition for "Switch to X"
- [ ] TTS confirmation on switch

### Phase 3: Avatar Binding
- [ ] Link personas to VRM models
- [ ] Auto-load persona avatar on switch
- [ ] Face generation tied to persona description

### Phase 4: Wake Word Support
- [ ] Allow custom Porcupine .ppn file per persona
- [ ] Hot-swap wake word on persona switch
- [ ] Multi-keyword detection (any persona can be invoked)

### Phase 5: Memory Isolation
- [ ] Session prefixing for isolated personas
- [ ] Separate conversation windows per persona
- [ ] Import/export persona with memory

## Prebuilt Persona Templates

Ship with a few starter templates users can customize:

```typescript
const PERSONA_TEMPLATES = [
  {
    name: 'Professional Assistant',
    voice: 'echo',
    systemInstructions: 'You are a professional executive assistant. Be concise, efficient, and proactive about scheduling and task management.',
    personalityTraits: ['formal', 'concise', 'proactive']
  },
  {
    name: 'Creative Companion', 
    voice: 'fable',
    systemInstructions: 'You are a creative muse who loves storytelling, art, and imagination. Help brainstorm ideas and explore creative possibilities.',
    personalityTraits: ['creative', 'encouraging', 'playful']
  },
  {
    name: 'Study Buddy',
    voice: 'nova',
    systemInstructions: 'You are a patient tutor. Explain concepts clearly, use analogies, and check for understanding. Encourage questions.',
    personalityTraits: ['patient', 'educational', 'supportive']
  }
];
```

## Open Questions

1. **Multi-wake-word**: Can Porcupine listen for multiple keywords simultaneously?
2. **Voice cloning**: Future support for custom voice models (ElevenLabs, etc.)?
3. **Persona sharing**: Import/export JSON for community persona sharing?
4. **Context handoff**: When switching personas mid-conversation, should context carry over?
5. **Usage analytics**: Track which personas are used most to suggest improvements?

## References

- [OpenAI Realtime API Voices](https://platform.openai.com/docs/guides/realtime)
- [Porcupine Custom Wake Words](https://picovoice.ai/docs/porcupine/)
- Current voice handling: `app/renderer/src/App.tsx` voice selector
