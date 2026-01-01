
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

const POSE_COMPILER_SYSTEM_PROMPT = [
    'You are a VRM pose specialist.',
    'Your task is to convert a detailed pose description into a valid VRM Pose JSON object.',
    '',
    'Target Schema:',
    '{',
    '  [boneName: string]: { "rotation": [x, y, z, w] }',
    '}',
    '',
    'Requirements:',
    '- Output ONLY valid JSON.',
    '- Use ONLY the provided valid VRM human bones.',
    '- All rotations must be local Quaternions [x, y, z, w].',
    '- Ensure anatomical plausibility.',
    '- Symmetrize where appropriate if the description implies symmetry.',
    '- For hands: Provide detailed finger rotations if described.',
    '',
    'IMPORTANT: Do NOT include position keys unless absolutely necessary for hips (e.g. crouching). VRM poses generally only use rotations.',
    'If hips position is needed, add "position": [x, y, z] to the hips object. Hips rest at Y≈1.0.',
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

        // Step 1: Expansion
        const expandedDescription = await this.runExpanderStep(prompt, modelDescription);
        this.logger?.info?.('Pose expansion generated.', {
            prompt,
            expandedDescription,
            expandedLength: expandedDescription.length
        });

        // Step 2: Compiler
        // We use a simplified JSON schema for the compiler output to ensure structure
        const poseJson = await this.runCompilerStep(expandedDescription, bones);
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

    private async runCompilerStep(description: string, bones: string[]): Promise<Record<string, unknown>> {
        const messages: ResponseInput = [
            {
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: POSE_COMPILER_SYSTEM_PROMPT }],
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
        // Note: OpenAI requires all properties to be in 'required', so we only include 'rotation'.
        // Position is rarely needed and the model can still output it as the schema allows additional properties at the bone level.
        const schema = {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: {
                type: 'object',
                properties: {
                    rotation: {
                        type: 'array',
                        items: { type: 'number' },
                        minItems: 4,
                        maxItems: 4,
                    },
                },
                required: ['rotation'],
                additionalProperties: true,
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

        return JSON.parse(outputText);
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
