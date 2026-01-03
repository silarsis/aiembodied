
import type OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses';
import type { AvatarPoseGenerationRequest, AvatarPoseUploadResult } from './types.js';
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
    'Bone Hierarchy (parent → child):',
    '- hips (root) → spine → chest → upperChest → neck → head',
    '- upperChest → leftShoulder → leftUpperArm → leftLowerArm → leftHand → fingers',
    '- upperChest → rightShoulder → rightUpperArm → rightLowerArm → rightHand → fingers',
    '- hips → leftUpperLeg → leftLowerLeg → leftFoot → leftToes',
    '- hips → rightUpperLeg → rightLowerLeg → rightFoot → rightToes',
].join('\n');

const POSE_ROTATION_GUIDANCE = [
    'IMPORTANT - Parent-Child Rotation Inheritance:',
    '- All rotations are LOCAL (relative to the parent bone).',
    '- Child bones inherit their parent\'s rotation automatically.',
    '- When a parent rotates, all descendants move with it.',
    '- Account for parent rotation when setting child rotations. For example:',
    '  - If leftUpperArm rotates 45° forward, leftLowerArm is already 45° forward.',
    '  - To keep the forearm straight relative to world, set leftLowerArm rotation to identity [0,0,0,1].',
    '  - To bend the elbow further, apply only the additional local rotation.',
].join('\n');

const POSE_REQUIREMENTS = [
    'Requirements:',
    '- Output ONLY valid JSON matching the schema above.',
    '- You MUST include ALL provided VRM bone names as top-level property keys.',
    '- All rotations must be local Quaternions [x, y, z, w].',
    '- For bones that do not change from the default pose, use identity rotation [0, 0, 0, 1].',
    '- Set position to null for all bones EXCEPT hips when vertical movement is needed.',
    '- For hips position (crouching/jumping only), use [x, y, z] where Y≈1.0 is standing.',
    '- Ensure anatomical plausibility.',
    '- Symmetrize where appropriate if the description implies symmetry.',
    '- For hands: Provide detailed finger rotations if described.',
].join('\n');

/**
 * Format bone hierarchy from a map of bone → parent into readable chains.
 */
function formatBoneHierarchy(hierarchy: Record<string, string | null>): string {
    if (!hierarchy || Object.keys(hierarchy).length === 0) {
        return POSE_HIERARCHY_FALLBACK;
    }

    // Build child → parent into parent → children
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
            chains.push(`- ${bone} → ${child}`);
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
        this.logger?.info?.('Pose JSON compiled.', { keys: Object.keys(poseJson).length });

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
    ): Promise<Record<string, unknown>> {
        const hierarchyText = formatBoneHierarchy(boneHierarchy);
        const systemPrompt = [
            POSE_COMPILER_SYSTEM_PROMPT_BASE,
            '',
            hierarchyText,
            '',
            POSE_ROTATION_GUIDANCE,
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

        // Build a strict JSON schema with all model bones as required properties
        // Each bone has rotation (required, 4 numbers) and position (optional, 3 numbers or null)
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

        // Parse the object-based response directly
        // Expected format: { [boneName]: { rotation: [x,y,z,w], position?: [x,y,z] | null } }
        let parsed: Record<string, unknown>;
        try {
            parsed = JSON.parse(outputText) as Record<string, unknown>;
        } catch (parseError) {
            const preview = outputText.slice(0, 200);
            const message = parseError instanceof Error ? parseError.message : String(parseError);
            this.logger?.error?.('Failed to parse pose JSON from LLM', { message, preview });
            throw new Error(`Pose compiler returned invalid JSON: ${message}. Response preview: ${preview}...`);
        }

        const result: Record<string, { rotation: number[]; position?: number[] }> = {};
        const validBoneSet = new Set(bones);
        const warnings: string[] = [];

        for (const [boneName, boneData] of Object.entries(parsed)) {
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
            const entry: { rotation: number[]; position?: number[] } = { rotation };

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

            result[boneName] = entry;
        }

        // Log any warnings
        if (warnings.length > 0) {
            this.logger?.warn?.('Pose parsing had validation issues', { warnings, boneCount: Object.keys(result).length });
            console.warn('[pose-generation] Validation warnings:', warnings);
        }

        // Ensure we have at least one valid bone
        if (Object.keys(result).length === 0) {
            const preview = outputText.slice(0, 200);
            this.logger?.error?.('No valid bones found in pose response', { preview, warnings });
            throw new Error(`Pose compiler returned no valid bones. Warnings: ${warnings.join('; ')}. Response preview: ${preview}...`);
        }

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
