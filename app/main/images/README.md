# Debug Images Directory

This directory contains debug images saved during avatar face upload processing (development mode only).

## Directory Structure

Each avatar upload creates a directory named with the face ID:
```
images/
├── {face-id-1}/
│   ├── original.png              # Original uploaded image
│   ├── request.json              # Full OpenAI API request details
│   ├── response.json             # Full OpenAI API response details
│   ├── base-seq0.png             # Base layer component
│   ├── eyes-open-seq0.png        # Eyes open component
│   ├── eyes-closed-seq0.png      # Eyes closed component
│   ├── mouth-neutral-seq0.png    # Neutral mouth component
│   ├── mouth-0-seq0.png          # Mouth shape 0 component
│   ├── mouth-1-seq0.png          # Mouth shape 1 component
│   ├── mouth-2-seq0.png          # Mouth shape 2 component
│   ├── mouth-3-seq0.png          # Mouth shape 3 component
│   └── mouth-4-seq0.png          # Mouth shape 4 component
└── {face-id-2}/
    └── ...
```

## Purpose

These files allow you to:
- **Inspect the original uploaded image** to understand what was sent to OpenAI
- **Review the full API request** (`request.json`) including prompts, model, and schema
- **Examine the complete API response** (`response.json`) including metadata, usage, and raw output
- **Examine each generated component** to see quality and alignment
- **Debug avatar generation issues** by visually comparing components
- **Verify transparency** and proper layering
- **Check consistency** across components
- **Analyze prompt effectiveness** and API response patterns

## Usage

1. Upload an avatar image in the application
2. Check the console logs for the face ID and debug directory path
3. Navigate to `app/main/images/{face-id}/` to inspect the images
4. Use any image viewer to examine the original and components

## Notes

- Debug images are only saved in **development mode** (NODE_ENV !== 'production')
- Each upload creates a new directory with a unique face ID
- Component filenames include the slot name and sequence number
- All generated components should be 150x150 pixels with transparent backgrounds
