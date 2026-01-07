# Speech-Driven Animation Feature

## Overview
This feature converts LLM speech transcript into animated avatar movements by calling a fast model to generate a timeline of poses synchronized to speech playback.

## Key Components
- **SpeechMovementService** (backend): Generates pose timelines from speech transcript
- **MovementAnimator** (frontend): Plays back keyframes via animation bus
- **Configurable delay modes**: `none`, `short`, `full` for testing different sync strategies

## Files
- `implementation_plan.md` - Detailed design and implementation steps

## Configuration
- `speechMovementDelayMode`: `'none' | 'short' | 'full'`
- `speechMovementDelayMs`: Delay for `short` mode (default 300ms)
- `speechMovementModel`: LLM model for timeline generation

## Status
Design phase - awaiting implementation approval
