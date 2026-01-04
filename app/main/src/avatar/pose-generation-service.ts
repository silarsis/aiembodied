
import type OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses';
import type { AvatarPoseGenerationRequest, AvatarPoseUploadResult, AvatarPoseData, PoseExpressionState } from './types.js';
import type { AvatarPoseService } from './avatar-pose-service.js';

export interface PoseGenerationServiceOptions {
    client: OpenAI;
    poseService: AvatarPoseService;
    logger?: {
        info?: (message: string, meta?: Record<string, unknown>) => void;
        warn?: (message: string, meta?: Record<string, unknown>) => void;
        error?: (message: string, meta?: Record<string, unknown>) => void;
    };
}

const POSE_EXPANDER_SYSTEM_PROMPT = [
    'You are an expert character acting director and movement analyst.',
    '',
    'Your task is to take a brief user request for a character pose and expand it into a rich, anatomically precise description.',
    'Focus on:',
    '- Body mechanics and weight distribution.',
    '- Specific limb placements (arms, legs, torso, head).',
    '- Hand shapes and finger details.',
    '- The expressiveness and emotion conveyed by the pose.',
    '- Ensuring the pose allows for a natural, balanced standing position (unless sitting/crouching is explicitly requested).',
    '',
    'Context:',
    'The output will be used by a compiler to generate a VRM humanoid pose JSON.',
    'Do NOT output JSON. Output a clear, descriptive paragraph.',
].join('\n');

const POSE_COMPILER_SYSTEM_PROMPT_BASE = [
    'You are a VRM pose specialist.',
    'Your task is to convert a detailed pose description into a VRM Pose JSON object.',
    '',
    'Output Schema:',
    '{',
    '  "hips": { "rotation": [x, y, z, w], "position": [x, y, z] },',
    '  "spine": { "rotation": [x, y, z, w] },',
    '  "chest": { "rotation": [x, y, z, w] }',
    '}',
].join('\n');

const POSE_HIERARCHY_FALLBACK = [
    'Bone Hierarchy (parent > child):',
    '- hips (root) > spine > chest > upperChest > neck > head',
    '- upperChest > leftShoulder > leftUpperArm > leftLowerArm > leftHand > fingers',
    '- upperChest > rightShoulder > rightUpperArm > rightLowerArm > rightHand > fingers',
    '- hips > leftUpperLeg > leftLowerLeg > leftFoot > leftToes',
    '- hips > rightUpperLeg > rightLowerLeg > rightFoot > rightToes',
].join('\n');

const POSE_ROTATION_GUIDANCE = [
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

const POSE_AXIS_MAPPING = [
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

const POSE_MAGNITUDE_GUIDE = [
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

const POSE_SYMMETRY_RULE = [
    'CRITICAL - Symmetry Rule for Left/Right Bone Pairs:',
    '- VRM uses a specific mirroring pattern for symmetric poses.',
    '- For any left/right bone pair (shoulders, arms, hands, fingers, legs, feet):',
    '  - Left quaternion:  [x,  y,  z, w]',
    '  - Right quaternion: [x, -y, -z, w]  (NEGATE both Y and Z components)',
    '- This rule applies because left and right bones have mirrored local coordinate systems.',
    '- Example: If leftUpperArm is [-0.087, -0.423, 0.259, 0.861],',
    '  then rightUpperArm should be [-0.087, 0.423, -0.259, 0.861].',
].join('\n');

const POSE_CONVERGENT_EXCEPTION = [
    'EXCEPTION - Convergent Poses (arms crossed, hands clasped, praying, hugging self):',
    '',
    'The symmetry rule above is for MIRRORED poses (hands on hips, arms akimbo, waving).',
    'For CONVERGENT poses where limbs meet at the body center, do NOT blindly negate Y and Z.',
    '',
    'Crossed Arms Example - What happens in 3D space:',
    '- BOTH upper arms must swing FORWARD (toward chest) - this requires considering the arm direction',
    '- BOTH forearms fold INWARD across the chest',
    '- Left arm typically goes OVER or UNDER right arm (or vice versa)',
    '',
    'Key insight for crossed arms:',
    '- leftUpperArm needs: negative X (lower from T-pose) AND rotation to bring arm toward chest center',
    '- rightUpperArm needs: same lowering AND rotation to bring arm toward chest center',
    '- The Z components work together to bring arms to center, not oppose each other',
    '- Think about WHERE the hands end up (opposite shoulders/upper arms), then work backward',
    '',
    'Use the Reference Example below as your primary guide for crossed arms.',
].join('\n');

const POSE_EXAMPLE = [
    'Reference Example - Crossed Arms Pose (arms folded across chest):',
    '{',
    '  "leftUpperArm":  { "rotation": [-0.087, -0.423,  0.259, 0.861] },',
    '  "leftLowerArm":  { "rotation": [ 0.000, -0.707,  0.000, 0.707] },',
    '  "rightUpperArm": { "rotation": [-0.087,  0.423, -0.259, 0.861] },',
    '  "rightLowerArm": { "rotation": [ 0.000,  0.707,  0.000, 0.707] }',
    '}',
    'Note: Y and Z are negated between left and right pairs.',
    'The Y component is CRITICAL for both upper arm positioning and elbow bending.',
].join('\n');

const POSE_REQUIREMENTS = [
    'Requirements:',
    '- Output ONLY valid JSON matching the schema above.',
    '- You MUST include ALL provided VRM bone names as top-level property keys under "bones".',
    '- All rotations must be local Quaternions [x, y, z, w] relative to T-pose.',
    '- Identity rotation [0, 0, 0, 1] means the bone stays in T-pose orientation.',
    '- For bones that do not change from the T-pose, use identity rotation [0, 0, 0, 1].',
    '- Set position to null for ALL bones. Do not adjust position values.',
    '- Ensure anatomical plausibility.',
    '- ALWAYS apply the symmetry rule above for left/right bone pairs.',
    '- For hands: Provide detailed finger rotations if described.',
    '- ALWAYS include facial expressions in the "expressions" object.',
].join('\n');

const POSE_EXPRESSION_GUIDANCE = [
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
function formatBoneHierarchy(hierarchy: Record<string, string | null>): string {
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

    function buildChain(bone: string, depth: number = 0): void {
        const children = childrenMap.get(bone) ?? [];
        if (children.length === 0) {
            return;
        }

        for (const child of children) {
            chains.push(`- ${bone} > ${child}`);
            buildChain(child, depth + 1);
        }
    }

    for (const root of roots) {
        chains.push(`- ${root} (root)`);
        buildChain(root);
    }

    return `Bone Hierarchy (from model):\n${chains.join('\n')}`;
}

export class PoseGenerationService {
    private readonly client: OpenAI;
    private readonly poseService: AvatarPoseService;
    private readonly logger?: PoseGenerationServiceOptions['logger'];

    constructor(options: PoseGenerationServiceOptions) {
        this.client = options.client;
        this.poseService = options.poseService;
        this.logger = options.logger;
    }

    async generatePose(request: AvatarPoseGenerationRequest): Promise<AvatarPoseUploadResult> {
        const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
        if (!prompt) {
            throw new Error('Pose generation prompt is required.');
        }

        const bones = this.normalizeBones(request?.bones);
        const modelDescription = typeof request?.modelDescription === 'string' ? request.modelDescription.trim() : undefined;
        const boneHierarchy = request?.boneHierarchy ?? {};

        // Step 1: Expansion
        const expandedDescription = await this.runExpanderStep(prompt, modelDescription);
        this.logger?.info?.('Pose expansion generated.', {
            prompt,
            expandedDescription,
            expandedLength: expandedDescription.length
        });

        // Step 2: Compiler
        // We use a simplified JSON schema for the compiler output to ensure structure
        const poseJson = await this.runCompilerStep(expandedDescription, bones, boneHierarchy);
        this.logger?.info?.('Pose JSON compiled.', {
            boneCount: Object.keys(poseJson.bones).length,
            hasExpressions: !!poseJson.expressions,
            expressionPresets: poseJson.expressions?.presets ? Object.keys(poseJson.expressions.presets) : [],
        });

        // Save
        const fileName = `${this.slugify(prompt.slice(0, 30))}-${Date.now()}.pose.json`;
        const data = JSON.stringify(poseJson, null, 2);

        let result: AvatarPoseUploadResult;
        try {
            result = await this.poseService.uploadPose({
                fileName,
                data,
                name: prompt,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger?.error?.('Failed to persist generated pose.', { message, fileName });
            throw error;
        }

        return result;
    }

    private async runExpanderStep(prompt: string, modelDescription?: string): Promise<string> {
        const messages: ResponseInput = [
            {
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: POSE_EXPANDER_SYSTEM_PROMPT }],
            },
        ];

        if (modelDescription) {
            messages.push({
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: `Character Description: ${modelDescription}` }],
            });
        }

        messages.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `Request: ${prompt}` }],
        });

        const response = await (
            this.client as unknown as {
                responses: { create: (args: unknown) => Promise<{ output_text: string }> };
            }
        ).responses.create({
            model: 'gpt-4.1-mini',
            input: messages,
            text: {},
        });

        return response.output_text || '';
    }

    private async runCompilerStep(
        description: string,
        bones: string[],
        boneHierarchy: Record<string, string | null>
    ): Promise<AvatarPoseData> {
        const hierarchyText = formatBoneHierarchy(boneHierarchy);
        const systemPrompt = [
            POSE_COMPILER_SYSTEM_PROMPT_BASE,
            '',
            hierarchyText,
            '',
            POSE_ROTATION_GUIDANCE,
            '',
            POSE_AXIS_MAPPING,
            '',
            POSE_MAGNITUDE_GUIDE,
            '',
            POSE_SYMMETRY_RULE,
            '',
            POSE_CONVERGENT_EXCEPTION,
            '',
            POSE_EXAMPLE,
            '',
            POSE_EXPRESSION_GUIDANCE,
            '',
            POSE_REQUIREMENTS,
        ].join('\n');

        const messages: ResponseInput = [
            {
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: systemPrompt }],
            },
        ];

        if (bones.length > 0) {
            messages.push({
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: `Valid VRM Bones: ${bones.join(', ')}` }],
            });
        }

        messages.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: `Description: ${description}` }],
        });

        // Build a strict JSON schema with nested structure:
        // { bones: { [boneName]: { rotation, position } }, expressions: { presets: { [name]: weight } } }
        // OpenAI's strict mode requires additionalProperties:false and all properties in required
        const boneSchema = {
            type: 'object' as const,
            additionalProperties: false,
            required: ['rotation', 'position'],
            properties: {
                rotation: {
                    type: 'array' as const,
                    items: { type: 'number' as const },
                    minItems: 4,
                    maxItems: 4,
                },
                position: {
                    anyOf: [
                        { type: 'null' as const },
                        {
                            type: 'array' as const,
                            items: { type: 'number' as const },
                            minItems: 3,
                            maxItems: 3,
                        },
                    ],
                },
            },
        };

        // Build properties object with each bone using the same schema
        const boneProperties: Record<string, typeof boneSchema> = {};
        for (const bone of bones) {
            boneProperties[bone] = boneSchema;
        }

        // Expression presets schema - VRM 1.0 emotion names with 0-1 weights
        const expressionPresetNames = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'] as const;
        const expressionPresetProperties: Record<string, { type: 'number' }> = {};
        for (const preset of expressionPresetNames) {
            expressionPresetProperties[preset] = { type: 'number' as const };
        }

        const schema = {
            type: 'object' as const,
            additionalProperties: false,
            required: ['bones', 'expressions'],
            properties: {
                bones: {
                    type: 'object' as const,
                    additionalProperties: false,
                    required: bones,
                    properties: boneProperties,
                },
                expressions: {
                    type: 'object' as const,
                    additionalProperties: false,
                    required: ['presets'],
                    properties: {
                        presets: {
                            type: 'object' as const,
                            additionalProperties: false,
                            required: expressionPresetNames as unknown as string[],
                            properties: expressionPresetProperties,
                        },
                    ],
                },
            },
        };

        // Build properties object with each bone using the same schema
        const boneProperties: Record<string, typeof boneSchema> = {};
        for (const bone of bones) {
            boneProperties[bone] = boneSchema;
        }

        const schema = {
            type: 'object' as const,
            additionalProperties: false,
            required: bones, // All bones are required
            properties: boneProperties,
        };

        const response = await (
            this.client as unknown as {
                responses: { create: (args: unknown) => Promise<{ output_text: string }> };
            }
        ).responses.create({
            model: 'gpt-4.1-mini',
            input: messages,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'vrm_pose',
                    schema: schema as unknown,
                    strict: true,
                },
            },
        });

        const outputText = response.output_text;
        if (!outputText) throw new Error('Empty response from pose compiler');
        console.log(JSON.stringify(messages), outputText);

        // Parse the object-based response with new structure:
        // { bones: { [boneName]: { rotation, position } }, expressions: { presets: {...} } }
        let parsed: { bones?: Record<string, unknown>; expressions?: { presets?: Record<string, unknown> } };
        try {
            parsed = JSON.parse(outputText) as typeof parsed;
        } catch (parseError) {
            const preview = outputText.slice(0, 200);
            const message = parseError instanceof Error ? parseError.message : String(parseError);
            this.logger?.error?.('Failed to parse pose JSON from LLM', { message, preview });
            throw new Error(`Pose compiler returned invalid JSON: ${message}. Response preview: ${preview}...`);
        }

        const bonesData = parsed.bones ?? {};
        const expressionsData = parsed.expressions ?? {};

        const resultBones: Record<string, { rotation: number[]; position?: number[] | null }> = {};
        const validBoneSet = new Set(bones);
        const warnings: string[] = [];

        for (const [boneName, boneData] of Object.entries(bonesData)) {
            // Validate bone name
            if (!validBoneSet.has(boneName)) {
                warnings.push(`Unknown bone '${boneName}' in response (not in valid bones list)`);
            }

            // Validate bone data structure
            if (typeof boneData !== 'object' || boneData === null) {
                warnings.push(`Invalid data for bone '${boneName}': expected object, got ${typeof boneData}`);
                continue;
            }

            const data = boneData as { rotation?: unknown; position?: unknown };

            // Validate rotation
            if (!Array.isArray(data.rotation) || data.rotation.length !== 4) {
                warnings.push(`Invalid rotation for bone '${boneName}': expected array of 4 numbers`);
                continue;
            }

            const rotation = data.rotation as number[];
            if (!rotation.every(n => typeof n === 'number' && Number.isFinite(n))) {
                warnings.push(`Invalid rotation values for bone '${boneName}': all values must be finite numbers`);
                continue;
            }

            // Build the result entry
            const entry: { rotation: number[]; position?: number[] | null } = { rotation };

            // Validate and add position if present
            if (data.position !== null && data.position !== undefined) {
                if (Array.isArray(data.position) && data.position.length === 3) {
                    const position = data.position as number[];
                    if (position.every(n => typeof n === 'number' && Number.isFinite(n))) {
                        entry.position = position;
                    } else {
                        warnings.push(`Invalid position values for bone '${boneName}': all values must be finite numbers`);
                    }
                } else {
                    warnings.push(`Invalid position for bone '${boneName}': expected array of 3 numbers or null`);
                }
            }

            resultBones[boneName] = entry;
        }

        // Parse and validate expressions
        const resultExpressions: PoseExpressionState = {};
        const validPresetNames = new Set(['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral']);

        if (expressionsData.presets && typeof expressionsData.presets === 'object') {
            const presets: Partial<Record<string, number>> = {};
            for (const [name, weight] of Object.entries(expressionsData.presets)) {
                if (!validPresetNames.has(name)) {
                    warnings.push(`Unknown expression preset '${name}'`);
                    continue;
                }
                if (typeof weight === 'number' && Number.isFinite(weight)) {
                    // Clamp to 0-1 range
                    presets[name] = Math.max(0, Math.min(1, weight));
                } else {
                    warnings.push(`Invalid weight for expression '${name}': expected number`);
                }
            }
            if (Object.keys(presets).length > 0) {
                resultExpressions.presets = presets as PoseExpressionState['presets'];
            }
        }

        // Log any warnings
        if (warnings.length > 0) {
            this.logger?.warn?.('Pose parsing had validation issues', { warnings, boneCount: Object.keys(resultBones).length });
            console.warn('[pose-generation] Validation warnings:', warnings);
        }

        // Ensure we have at least one valid bone
        if (Object.keys(resultBones).length === 0) {
            const preview = outputText.slice(0, 200);
            this.logger?.error?.('No valid bones found in pose response', { preview, warnings });
            throw new Error(`Pose compiler returned no valid bones. Warnings: ${warnings.join('; ')}. Response preview: ${preview}...`);
        }

        const result: AvatarPoseData = {
            bones: resultBones,
            expressions: Object.keys(resultExpressions).length > 0 ? resultExpressions : undefined,
        };

        console.log(JSON.stringify(result));
        return result;
    }

    private normalizeBones(bones?: string[]): string[] {
        if (!Array.isArray(bones)) {
            return [];
        }
        return Array.from(new Set(bones.filter(b => typeof b === 'string' && b.length > 0).map(b => b.trim()))).sort();
    }

    private slugify(text: string): string {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/(^-|-$)+/g, '');
    }
}
