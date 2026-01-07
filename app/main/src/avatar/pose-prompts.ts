/**
 * Shared pose generation prompt constants.
 * Used by both PoseGenerationService and SpeechMovementService.
 */

/**
 * Bone hierarchy fallback when model hierarchy is unavailable.
 */
export const POSE_HIERARCHY_FALLBACK = [
    'Bone Hierarchy (parent > child):',
    '- hips (root) > spine > chest > upperChest > neck > head',
    '- upperChest > leftShoulder > leftUpperArm > leftLowerArm > leftHand > fingers',
    '- upperChest > rightShoulder > rightUpperArm > rightLowerArm > rightHand > fingers',
    '- hips > leftUpperLeg > leftLowerLeg > leftFoot > leftToes',
    '- hips > rightUpperLeg > rightLowerLeg > rightFoot > rightToes',
].join('\n');

/**
 * Rotation guidance explaining T-pose and local rotation system.
 */
export const POSE_ROTATION_GUIDANCE = [
    'IMPORTANT - T-Pose Bind Pose and Rotation System:',
    '- VRM models use T-pose as the bind/rest pose (arms extended horizontally, palms down).',
    '- All rotations are RELATIVE to T-pose. Identity quaternion [0,0,0,1] = T-pose orientation.',
    '- Rotations are LOCAL (relative to the parent bone in the hierarchy).',
    '- Child bones inherit their parent\'s rotation automatically.',
    '- When a parent rotates, all descendants move with it.',
    '- Account for parent rotation when setting child rotations. For example:',
    '  - If leftUpperArm rotates 45 degrees forward, leftLowerArm is already 45 degrees forward.',
    '  - To keep the forearm straight relative to world, set leftLowerArm rotation to identity [0,0,0,1].',
    '  - To bend the elbow further, apply only the additional local rotation.',
].join('\n');

/**
 * Axis-to-movement mapping for quaternion rotations.
 */
export const POSE_AXIS_MAPPING = [
    'CRITICAL - Axis-to-Movement Mapping (quaternion [x, y, z, w]):',
    '',
    'Upper Arms (leftUpperArm, rightUpperArm) - FROM T-POSE:',
    '- Y-axis is PRIMARY: Controls bringing arm toward/away from body',
    '  - Left arm: negative Y = rotate arm forward and inward toward chest',
    '  - Right arm: positive Y = rotate arm forward and inward toward chest (mirrored)',
    '- Z-axis: Additional forward/backward swing adjustment',
    '- X-axis: Minor vertical adjustment (small values only)',
    '- For crossed arms: Y is the LARGEST component (≈0.4), Z is medium (≈0.25), X is small (≈0.09)',
    '',
    'Lower Arms/Forearms (leftLowerArm, rightLowerArm):',
    '- Y-axis is PRIMARY: Controls elbow bend/flexion',
    '  - Left arm: negative Y = bend elbow to bring forearm across chest',
    '  - Right arm: positive Y = bend elbow to bring forearm across chest (mirrored)',
    '- For crossed arms: Y should be ≈0.707 (90° bend) with X and Z near zero',
    '',
    'Head and Neck:',
    '- X-axis: Nod up/down (negative X = look down, positive X = look up)',
    '- Y-axis: Turn left/right (positive Y = turn left, negative Y = turn right)',
    '- Z-axis: Tilt ear to shoulder (positive Z = tilt left, negative Z = tilt right)',
    '',
    'Spine, Chest, UpperChest:',
    '- X-axis: Lean forward/backward (positive X = lean back, negative X = lean forward)',
    '- Y-axis: Twist torso left/right',
    '- Z-axis: Lean side to side (positive Z = lean left, negative Z = lean right)',
    '',
    'Fingers (all finger bones):',
    '- X-axis: Curl fingers (positive X = curl/close fist)',
    '- Z-axis: Spread fingers apart',
].join('\n');

/**
 * Magnitude reference for quaternion rotation values.
 */
export const POSE_MAGNITUDE_GUIDE = [
    'Rotation Magnitude Reference (quaternion component values):',
    '- Subtle/slight movement: |value| ≈ 0.05 to 0.15 (~5-15 degrees)',
    '- Small movement: |value| ≈ 0.15 to 0.25 (~15-25 degrees)',
    '- Medium movement: |value| ≈ 0.25 to 0.40 (~25-45 degrees)',
    '- Large movement: |value| ≈ 0.40 to 0.60 (~45-70 degrees)',
    '- Extreme movement: |value| ≈ 0.60 to 0.707 (~70-90 degrees)',
    '',
    'Remember: The w component adjusts to keep the quaternion normalized.',
    'For single-axis rotations, use: [x, y, z, w] where w = sqrt(1 - x² - y² - z²)',
].join('\n');

/**
 * Symmetry rule for left/right bone pairs.
 */
export const POSE_SYMMETRY_RULE = [
    'CRITICAL - Symmetry Rule for Left/Right Bone Pairs:',
    '- VRM uses a specific mirroring pattern for symmetric poses.',
    '- For any left/right bone pair (shoulders, arms, hands, fingers, legs, feet):',
    '  - Left quaternion:  [x,  y,  z, w]',
    '  - Right quaternion: [x, -y, -z, w]  (NEGATE both Y and Z components)',
    '- This rule applies because left and right bones have mirrored local coordinate systems.',
    '- Example: If leftUpperArm is [-0.087, -0.423, 0.259, 0.861],',
    '  then rightUpperArm should be [-0.087, 0.423, -0.259, 0.861].',
].join('\n');

/**
 * VRM 1.0 facial expression guidance.
 */
export const POSE_EXPRESSION_GUIDANCE = [
    'FACIAL EXPRESSIONS - VRM 1.0 Preset Names:',
    '',
    'You must include an "expressions" object with facial expression weights.',
    'Expression weights range from 0.0 (off) to 1.0 (full intensity).',
    '',
    'Available emotion presets (use 1-2 that match the pose mood):',
    '- happy: Joy, smile, positive emotions',
    '- angry: Frown, furrowed brows, tension',
    '- sad: Downturned mouth, sorrowful look',
    '- relaxed: Calm, peaceful, slight smile',
    '- surprised: Wide eyes, raised brows',
    '- neutral: Default, no particular emotion',
    '',
    'Guidelines:',
    '- Choose expressions that match the pose\'s emotional intent.',
    '- Use weights between 0.3-0.8 for natural looks; 1.0 can look exaggerated.',
    '- Blend 2 emotions for nuance (e.g., happy: 0.6, relaxed: 0.3).',
    '- For neutral poses, use neutral: 1.0 or relaxed: 0.5.',
    '',
    'Example output structure:',
    '{',
    '  "bones": { "hips": {...}, "spine": {...}, ... },',
    '  "expressions": {',
    '    "presets": { "happy": 0.7, "relaxed": 0.3 }',
    '  }',
    '}',
].join('\n');

/**
 * Format bone hierarchy from a map of bone > parent into readable chains.
 */
export function formatBoneHierarchy(hierarchy: Record<string, string | null>): string {
    if (!hierarchy || Object.keys(hierarchy).length === 0) {
        return POSE_HIERARCHY_FALLBACK;
    }

    // Build child > parent into parent > children
    const childrenMap = new Map<string | null, string[]>();
    for (const [bone, parent] of Object.entries(hierarchy)) {
        const children = childrenMap.get(parent) ?? [];
        children.push(bone);
        childrenMap.set(parent, children);
    }

    // Find root bones (those with null parent)
    const roots = childrenMap.get(null) ?? [];
    if (roots.length === 0) {
        return POSE_HIERARCHY_FALLBACK;
    }

    // Build chains from each root
    const chains: string[] = [];

    function buildChain(bone: string): void {
        const children = childrenMap.get(bone) ?? [];
        if (children.length === 0) {
            return;
        }

        for (const child of children) {
            chains.push(`- ${bone} > ${child}`);
            buildChain(child);
        }
    }

    for (const root of roots) {
        chains.push(`- ${root} (root)`);
        buildChain(root);
    }

    return `Bone Hierarchy (from model):\n${chains.join('\n')}`;
}
