# Furniture Feature Plan

## Overview
Create a user-facing furniture curation and generation system, similar to the existing background system but focused on 3D room objects.

## Current State

### What Already Exists
1. **3D Room System** (`docs/features/3d-rooms.md`)
   - Two built-in rooms: Reading room, Studio flat
   - Each contains static furniture (sofa, chair, table, bookshelf, etc.)
   - Furniture defined as `RoomObject` with 3D geometry (box/cylinder/sphere) or model references
   - Poly Haven asset library integration for real 3D models

2. **Background System** (reference pattern)
   - 2D picture backgrounds with:
     - Library browser (`BackgroundControls`)
     - Generation from text description
     - Selection and deletion
   - Main: `app/main/src/backgrounds/`
   - Renderer: `app/renderer/src/backgrounds/`

3. **Room Generation** (`app/main/src/rooms/room-generation.ts`)
   - Generates rooms from text description
   - Furniture from Poly Haven library (searchable by category)
   - Falls back to generated images → 3D models if not in library

## What's Missing

### User-Facing Furniture Interface
1. **Furniture Library Browser**
   - Grid view of available furniture pieces
   - Search/filter by category (chair, table, shelf, etc.)
   - Visual thumbnails
   - One-click addition to room

2. **Furniture Generator**
   - Text-to-furniture generation (like background generator)
   - Customization of appearance (material, color, style)
   - Real-time preview before adding

3. **Room Furniture Manager**
   - Add/remove furniture from existing rooms
   - Position/orientation controls
   - Visual placement in room preview

## Implementation Plan

### Phase 1: Furniture Library & Selection (Minimal MVP)

#### 1. Furniture Data Structure
Create `app/main/src/furniture/types.ts`:
```typescript
interface FurnitureItem {
  id: string;
  name: string;
  category: 'seating' | 'tables' | 'storage' | 'lighting' | 'decor' | 'appliances';
  description?: string;
  dimensions: { width: number; height: number; depth: number };
  model?: { file: string; scale: number };  // Poly Haven reference
  thumbnail: string;  // Data URL or path
  builtIn: boolean;
}
```

#### 2. Furniture Service
Create `app/main/src/furniture/furniture-service.ts`:
- `list(): FurnitureItem[]` - All available furniture
- `get(id): FurnitureItem` - Single item details
- `addToRoom(id, position, rotation): RoomObject` - Convert to room object
- `generate(description): Promise<FurnitureItem>` - Create new piece

#### 3. Furniture Library UI
Create `app/renderer/src/furniture/furniture-browser.tsx`:
- Grid of furniture cards (thumbnails + name)
- Category filters
- Search box
- "Add to room" button

#### 4. Integration Points
- Add to room creation flow
- Add to existing room editing
- IPC channels for bridge

### Phase 2: Furniture Generator

#### 1. Generator Service
Extend furniture-service:
- Use ComfyUI image generation
- Generate 3D model from image (via existing avatar generation pipeline)
- Support customization parameters

#### 2. Generator UI
Create `app/renderer/src/furniture/furniture-generator.tsx`:
- Text prompt input
- Customization controls (material, color, style)
- Preview image
- "Generate" button

### Phase 3: Advanced Features

#### 1. Furniture Manager
- Position/orientation controls
- Copy/duplicate furniture
- Batch operations

#### 2. Furniture Library Management
- Import/export furniture
- User-submitted furniture
- Community library (optional)

## Technical Considerations

### Reuse Existing Systems
1. **Background Service Pattern** - Same structure for library/generation
2. **Room Object Format** - Furniture becomes `RoomObject` in room file
3. **Poly Haven Integration** - Leverage existing search/catalog
4. **ComfyUI Pipeline** - Use existing image + 3D generation

### Data Storage
- Library: `userData/furniture/library.json`
- User-generated: `userData/furniture/generated/`
- Thumbnails: `userData/furniture/thumbnails/`

### Performance
- Lazy-load thumbnails
- Paginate large libraries
- Background generation with progress

## User Workflow

### Adding Furniture to Room
1. User opens room controls
2. Navigates to "Furniture" tab
3. Browses library or searches
4. Clicks "Add to room"
5. Furniture appears in room (preview or live)

### Creating Custom Furniture
1. User enters "Generate furniture"
2. Types description (e.g., "leather armchair, dark brown")
3. Adjusts customization options
4. Clicks "Generate"
5. Preview appears
6. Confirms → added to library & room

## Next Steps

1. ✅ Implement furniture types & service (Phase 1)
2. ✅ Create furniture browser UI
3. ✅ Wire up to room system
4. ✅ Add generation (Phase 2)
5. Test with real users

## Notes

- Furniture should integrate with existing room physics/collision
- Consider furniture categories matching Poly Haven tags
- Keep consistent with background system UX patterns
- May want separate "furniture library" from room generation
