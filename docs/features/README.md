# Feature Designs

This directory contains design documents for potential future features of the Embodied ChatGPT Assistant.

## Status Legend

| Status | Meaning |
|--------|---------|
| **Design Draft** | Initial brainstorm, not yet reviewed |
| **Under Review** | Being discussed for implementation |
| **Approved** | Ready for implementation |
| **In Progress** | Currently being built |
| **Shipped** | Available in the app |

## Feature Index

| # | Feature | Priority | Status | Description |
|---|---------|----------|--------|-------------|
| 01 | [Plugin/Tool System](./01-plugin-tool-system.md) | High | Draft | External tool integration with Home Assistant MCP |
| 02 | [Custom Voice Personas](./02-custom-voice-personas.md) | Medium | Draft | Multiple personalities with unique voices and memories |
| 03 | [Scheduled Actions](./03-scheduled-actions.md) | Medium | Draft | Reminders, routines, and time-based triggers |

## Feature Dependencies

```
┌─────────────────────────────────────────────────────────┐
│                                                         │
│   Plugin/Tool System (01)                               │
│          │                                              │
│          │ enables                                      │
│          ▼                                              │
│   Scheduled Actions (03) ──► tool triggers at times    │
│          │                                              │
│          │ can use                                      │
│          ▼                                              │
│   Custom Personas (02) ──► persona-specific schedules  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Suggested Implementation Order

1. **Plugin/Tool System** - Foundation for external integrations
2. **Scheduled Actions** - Depends on tool system for automation
3. **Custom Personas** - Enhances UX, can bind scheduled actions

## Contributing

When adding a new feature design:

1. Create a new numbered markdown file (e.g., `04-feature-name.md`)
2. Use the existing templates as a guide
3. Include: Overview, Goals, Data Model, Architecture, UI, Phases
4. Update this README's index table
5. Consider dependencies on other features
