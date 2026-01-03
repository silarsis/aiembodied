
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
    '  "bones": [',
    '    { "name": "boneName", "rotation": [x, y, z, w], "position": null }',
    '  ]',
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
    'IMPORTANT - Parent-Child Rotation Inheritance:',
    '- All rotations are LOCAL (relative to the parent bone).',
    '- Child bones inherit their parent\'s rotation automatically.',
    '- When a parent rotates, all descendants move with it.',
    '- Account for parent rotation when setting child rotations. For example:',
    '  - If leftUpperArm rotates 45 degrees forward, leftLowerArm is already 45 degrees forward.',
    '  - To keep the forearm straight relative to world, set leftLowerArm rotation to identity [0,0,0,1].',
    '  - To bend the elbow further, apply only the additional local rotation.',
].join('\n');

const POSE_REQUIREMENTS = [
    'Requirements:',
    '- Output ONLY valid JSON matching the schema above.',
    '- Use ONLY the provided valid VRM human bones for the "name" field.',
    '- All rotations must be local Quaternions [x, y, z, w].',
    '- Set "position" to null for all bones EXCEPT hips when vertical movement is needed.',
    '- For hips position (crouching/jumping only), use [x, y, z] where Y≈1.0 is standing.',
    '- Ensure anatomical plausibility.',
    '- Symmetrize where appropriate if the description implies symmetry.',
    '- For hands: Provide detailed finger rotations if described.',
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

        // Define a strict schema for the pose
        // OpenAI structured outputs require all properties in 'required' and don't support
        // dynamic keys via additionalProperties. Use an array of bone transforms instead.
        // Position is nullable since it's only needed for hips in crouching/jumping poses.
        const schema = {
            type: 'object',
            additionalProperties: false,
            required: ['bones'],
            properties: {
                bones: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['name', 'rotation', 'position'],
                        properties: {
                            name: { type: 'string' },
                            rotation: {
                                type: 'array',
                                items: { type: 'number' },
                                minItems: 4,
                                maxItems: 4,
                            },
                            position: {
                                anyOf: [
                                    { type: 'null' },
                                    {
                                        type: 'array',
                                        items: { type: 'number' },
                                        minItems: 3,
                                        maxItems: 3,
                                    },
                                ],
                            },
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
                },
            },
        });

        const outputText = response.output_text;
        if (!outputText) throw new Error('Empty response from pose compiler');
        console.log(JSON.stringify(messages), outputText);

        // Parse the array-based response and convert to object format
        // The API returns: { bones: [{ name, rotation, position }] }
        // We need: { [boneName]: { rotation, position? } }
        const parsed = JSON.parse(outputText) as { bones: Array<{ name: string; rotation: number[]; position: number[] | null }> };
        const result: Record<string, { rotation: number[]; position?: number[] }> = {};
        for (const bone of parsed.bones) {
            result[bone.name] = { rotation: bone.rotation };
            if (bone.position !== null) {
                result[bone.name].position = bone.position;
            }
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
