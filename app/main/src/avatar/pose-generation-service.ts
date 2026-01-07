
import type OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses';
import type { AvatarPoseGenerationRequest, AvatarPoseUploadResult, AvatarPoseData, PoseExpressionState } from './types.js';
import type { AvatarPoseService } from './avatar-pose-service.js';
import {
    POSE_AXIS_MAPPING,
    POSE_EXPRESSION_GUIDANCE,
    POSE_MAGNITUDE_GUIDE,
    POSE_ROTATION_GUIDANCE,
    POSE_SYMMETRY_RULE,
    formatBoneHierarchy,
} from './pose-prompts.js';

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
                    },
                },
            },
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
