import type OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses';
import { VRMA_JSON_SCHEMA, VRMA_PLAN_JSON_SCHEMA, parseVrmaSchema, VRMA_SLUG_PATTERN } from './vrma-schema.js';
import { buildVrmAnimation, encodeVrmaGlb } from './vrma-converter.js';
import type {
  AvatarAnimationUploadResult,
  AvatarAnimationSummary,
  AvatarAnimationGenerationRequest,
} from './types.js';
import type { AvatarAnimationService } from './avatar-animation-service.js';

export interface VrmaGenerationServiceOptions {
  client: OpenAI;
  animationService: AvatarAnimationService;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

const VRMA_PLANNER_SYSTEM_PROMPT = [
  'You are a senior character animator planning high-quality VRM humanoid animations for a kiosk avatar.',
  '',
  'Your task in THIS STEP is ONLY to design an animation plan, NOT to output final VRM keyframes.',
  'You will output a JSON animation plan that describes:',
  '- Phases of motion over time (anticipation, main action, overshoot, settle, idle, etc.).',
  '- Which bones are involved, their roles (primary/secondary/counter/stabilizer), and how they move.',
  '- Timing, approximate peak angles, arcs, and easing hints.',
  '- Where to use secondary motion: follow-through, overlap, small delays between bones.',
  '- Facial expressions and eye/head motion where relevant.',
  '',
  'Do NOT output quaternions or numeric keyframe arrays in this step.',
  'Instead, give clear, concise descriptions that a separate compiler can convert into bone-space quaternions.',
  '',
  'Constraints and style:',
  '- Use only the provided valid VRM human bones.',
  '- Keep animations anatomically reasonable for a standing humanoid; avoid impossible joint angles.',
  '- Favor upper-body gestures (head, neck, spine, shoulders, arms, hands) for kiosk scenarios.',
  '- Use classic animation principles: anticipation, clear key poses, arcs, follow-through, overlapping action, ease-in/ease-out, and settling into a relaxed neutral.',
  '- For looping animations, make sure the last phase returns smoothly to a neutral pose that matches the loop start.',
  '',
  'Keyframe density guidance (for the compiler):',
  '- Slow or idle motions: low to medium density.',
  '- Gestures and head moves: medium density.',
  '- Quick accents, overshoots, or eye blinks: high density over short intervals.',
  '',
  'Output ONLY valid JSON that matches the provided planning schema.',
].join('\n');

const VRMA_COMPILER_SYSTEM_PROMPT = [
  'You are a VRM animation compiler that converts an animation PLAN into precise VRM humanoid animation data.',
  '',
  'You are given:',
  '- A JSON animation plan describing phases, timing, bones, and easing hints.',
  '- A list of valid VRM human bones.',
  '',
  'Your task:',
  '- Produce final VRM animation JSON that matches the provided VRMA JSON schema exactly.',
  '- Use only the valid bone names for rotation tracks.',
  '- Use local bone-space quaternions for all rotation keyframes.',
  '- IMPORTANT: Only include hips.position keyframes if the animation has explicit vertical body movement.',
  '- "Vertical body movement" means jumping, crouching, or major weight shifts down/up. DO NOT include hips.position for head turns, arm waves, or upper-body only gestures.',
  '- CRITICAL: hips.position keyframes represent world-space Y displacement. The avatar rests at Y=1.0 (feet on ground).',
  '  * When outputting hips keyframes, NEVER use Y=0 or any Y < 0.95. This drops the character below ground.',
  '  * Use values close to 1.0: Y=1.03 for a jump, Y=0.98 for a slight crouch, Y=1.0 for standing.',
  '  * If the plan does NOT call for vertical movement, MUST output: "hips": {} (empty object, no position field).',
  '- Only populate "expressions" array if the plan indicates facial expressions; otherwise use an empty array: "expressions": []',
  '',
  'Animation quality guidelines:',
  '- Respect the phases and timing from the plan: anticipation, main action, overshoot, settle, etc.',
  '- Use the plan\'s "approxDuration" and "recommendedFps" to determine the time range and spacing of keyframes.',
  '- Place keyframes at:',
  '  * The start and end of each phase.',
  '  * Important extremes of motion (highest wave, deepest nod, furthest turn).',
  '  * Anticipation and overshoot poses.',
  '  * Settling poses as the avatar returns to neutral.',
  '- Use keyframe spacing to approximate easing:',
  '  * easeIn: tighter spacing near the start.',
  '  * easeOut: tighter spacing near the end.',
  '  * easeInOut: more spacing in the middle, tighter at both ends.',
  '- Keep rotations anatomically plausible; avoid extreme angles that would look broken.',
  '',
  'Secondary motion and realism:',
  '- Let primary bones lead and secondary bones follow with a slight delay (a few frames):',
  '  * e.g. shoulder leads, upperArm follows, forearm and hand lag slightly.',
  '  * head and neck settle a bit after the torso finishes turning.',
  '- Add small, subtle motion to avoid stiffness:',
  '  * gentle breathing in spine/shoulders during holds.',
  '  * tiny head and eye adjustments during longer phases.',
  '- For facial expressions, smoothly blend weights in and out (no instant snaps) unless the plan calls for a sharp reaction.',
  '',
  'Looping:',
  '- If meta.loop is true, ensure the pose and expression at the final time closely match the start so the animation loops seamlessly.',
  '- Avoid abrupt changes at the loop seam; let motions slow slightly into the loop.',
  '',
  'Meta and schema rules:',
  '- Copy "meta.name", "loop", and "kind" from the plan when present.',
  '- Choose "fps" from the plan\'s "recommendedFps" if available, otherwise use 30.',
  '- Set "duration" to the final keyframe time, or the plan\'s approxDuration if consistent.',
  '- REQUIRED: Always include both "hips" and "expressions" in the output (schema requires them).',
  '- For "hips": If there is NO vertical body movement, output "hips": {} (empty object, NO position field).',
  '- For "hips": If there IS movement, ALL keyframes must use Y >= 0.997 (the rest position is Y=1.0).',
  '- For "expressions": Always include as an array. Use [] if no facial expressions are needed.',
  '- DO NOT output hips keyframes with Y=0. This causes the character to drop to the origin, creating visible bobbing.',
  '',
  'Keyframe density limits:',
  '- Use at most 3-4 keyframes per second per bone except during very fast accents.',
  '- For a 2-second animation, most bones should have 4-8 keyframes total.',
  '',
  'Very important:',
  '- Do NOT invent movements that contradict the plan. You may add small natural overlaps or settles consistent with it.',
  '- Do NOT include bones that are not in the valid VRM list.',
  '- Return ONLY JSON that matches the VRMA JSON schema. No comments or explanations.',
].join('\n');

function normalizeBones(bones?: string[]): string[] {
  if (!Array.isArray(bones)) {
    return [];
  }

  const cleaned = bones
    .map((bone) => (typeof bone === 'string' ? bone.trim() : ''))
    .filter((bone) => bone.length > 0);

  return Array.from(new Set(cleaned)).sort();
}

function findInvalidBones(definition: { tracks: Array<{ bone: string }> }, validBones: string[]): string[] {
  if (validBones.length === 0) {
    return [];
  }

  const validSet = new Set(validBones);
  const invalid = new Set<string>();
  for (const track of definition.tracks) {
    if (!validSet.has(track.bone)) {
      invalid.add(track.bone);
    }
  }

  return Array.from(invalid).sort();
}

function buildPlannerInput(prompt: string, bones: string[], modelDescription?: string): ResponseInput {
  const messages: ResponseInput = [
    {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: VRMA_PLANNER_SYSTEM_PROMPT }],
    },
  ];

  if (modelDescription) {
    const descText = [
      'Character description (adapt animations to match this character):',
      modelDescription,
    ].join('\n');
    messages.push({
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: descText }],
    });
  }

  if (bones.length > 0) {
    const boneText = `Valid VRM human bones: ${bones.join(', ')}. Use only these bone names in the 'bones.bone' fields.`;
    messages.push({
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: boneText }],
    });
  }

  messages.push({
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: prompt }],
  });

  return messages;
}

function buildCompilerInput(planJson: unknown, bones: string[], invalidBones?: string[]): ResponseInput {
  const messages: ResponseInput = [
    {
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: VRMA_COMPILER_SYSTEM_PROMPT }],
    },
  ];

  if (bones.length > 0) {
    messages.push({
      type: 'message',
      role: 'system',
      content: [{ type: 'input_text', text: `Valid VRM human bones: ${bones.join(', ')}. Use only these bone names.` }],
    });
  }

  if (invalidBones && invalidBones.length > 0) {
    messages.push({
      type: 'message',
      role: 'system',
      content: [
        {
          type: 'input_text',
          text: `Invalid bones detected in the previous output: ${invalidBones.join(', ')}. Regenerate using only the valid bone names.`,
        },
      ],
    });
  }

  messages.push({
    type: 'message',
    role: 'user',
    content: [
      {
        type: 'input_text',
        text: `Here is the animation plan JSON. Convert it into final VRM animation JSON:\n\n${JSON.stringify(planJson, null, 2)}`,
      },
    ],
  });

  return messages;
}

export class VrmaGenerationService {
  private readonly client: OpenAI;
  private readonly animationService: AvatarAnimationService;
  private readonly logger?: VrmaGenerationServiceOptions['logger'];

  constructor(options: VrmaGenerationServiceOptions) {
    this.client = options.client;
    this.animationService = options.animationService;
    this.logger = options.logger;
  }

  async generateAnimation(request: AvatarAnimationGenerationRequest): Promise<AvatarAnimationUploadResult> {
    const prompt = typeof request?.prompt === 'string' ? request.prompt.trim() : '';
    if (!prompt) {
      throw new Error('VRMA generation prompt is required.');
    }

    const bones = normalizeBones(request?.bones);
    const modelDescription = typeof request?.modelDescription === 'string' ? request.modelDescription.trim() : undefined;

    const plan = await this.runPlannerStep(prompt, bones, modelDescription);
    const planMeta = plan as { meta?: { name?: string } };
    this.logger?.info?.('VRMA animation plan generated.', { planName: planMeta?.meta?.name, hasModelDescription: !!modelDescription });

    const definition = await this.runCompilerStep(plan, bones);

    if (!VRMA_SLUG_PATTERN.test(definition.meta.name)) {
      throw new Error('VRMA metadata name must be a slug.');
    }

    const vrmAnimation = buildVrmAnimation(definition);
    const glbBuffer = encodeVrmaGlb(definition);
    const fileName = `${definition.meta.name}.vrma`;
    const data = glbBuffer.toString('base64');

    let result: AvatarAnimationUploadResult;
    try {
      result = await this.animationService.uploadAnimation({
        fileName,
        data,
        name: definition.meta.name,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Failed to persist generated VRMA animation.', { message, fileName });
      throw error;
    }

    const animation = result.animation as AvatarAnimationSummary | undefined;
    this.logger?.info?.('VRMA animation generated.', {
      id: animation?.id ?? null,
      name: animation?.name ?? definition.meta.name,
      duration: animation?.duration ?? vrmAnimation.duration,
      metaDuration: definition.meta.duration ?? null,
    });

    return result;
  }

  private async runPlannerStep(prompt: string, bones: string[], modelDescription?: string): Promise<unknown> {
    const input = buildPlannerInput(prompt, bones, modelDescription);

    const response = await this.callModel(input, {
      type: 'json_schema',
      name: 'vrma_animation_plan',
      schema: VRMA_PLAN_JSON_SCHEMA,
    });

    const outputText = response?.output_text ?? '';
    if (!outputText) {
      throw new Error('VRMA planner returned an empty response.');
    }

    try {
      return JSON.parse(outputText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`VRMA planner returned invalid JSON: ${message}`);
    }
  }

  private async runCompilerStep(
    plan: unknown,
    bones: string[],
    invalidBones?: string[],
  ): Promise<ReturnType<typeof parseVrmaSchema>> {
    const input = buildCompilerInput(plan, bones, invalidBones);

    const response = await this.callModel(input, {
      type: 'json_schema',
      name: 'vrma_animation',
      schema: VRMA_JSON_SCHEMA,
    });

    const outputText = response?.output_text ?? '';
    if (!outputText) {
      throw new Error('VRMA compiler returned an empty response.');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(outputText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`VRMA compiler returned invalid JSON: ${message}`);
    }

    const definition = parseVrmaSchema(parsed);

    this.logger?.info?.('VRMA compiler output (JSON)', {
      meta: definition.meta,
      tracksCount: definition.tracks.length,
      hasHipsPosition: !!(definition.hips && definition.hips.position && definition.hips.position.keyframes?.length),
      hipsPositionKeyframes: definition.hips?.position?.keyframes?.length ?? 0,
      expressionsCount: definition.expressions?.length ?? 0,
      fullJson: JSON.stringify(definition),
    });

    const detectedInvalidBones = findInvalidBones(definition, bones);
    if (detectedInvalidBones.length > 0) {
      if (invalidBones && invalidBones.length > 0) {
        throw new Error(
          `VRMA generation used unsupported bones: ${detectedInvalidBones.join(', ')}. Valid bones: ${bones.join(', ')}.`,
        );
      }
      return this.runCompilerStep(plan, bones, detectedInvalidBones);
    }

    return definition;
  }

  private async callModel(
    input: ResponseInput,
    format: { type: 'json_schema'; name: string; schema: unknown },
  ): Promise<{ output_text: string }> {
    const response = await (
      this.client as unknown as {
        responses: { create: (args: unknown) => Promise<{ output_text: string }> };
      }
    ).responses.create({
      model: 'gpt-4.1-mini',
      input,
      text: { format },
    });

    return response;
  }
}
