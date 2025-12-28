import type OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses';

export interface AvatarDescriptionServiceOptions {
  client: OpenAI;
  logger?: {
    info?: (message: string, meta?: Record<string, unknown>) => void;
    warn?: (message: string, meta?: Record<string, unknown>) => void;
    error?: (message: string, meta?: Record<string, unknown>) => void;
  };
}

const DESCRIPTION_SYSTEM_PROMPT = [
  'You are analyzing a 3D avatar model screenshot to generate a character description.',
  'This description will be used to help generate appropriate animations for the character.',
  '',
  'Describe the following aspects concisely:',
  '- Art style (anime/stylized, semi-realistic, photorealistic, chibi, etc.)',
  '- Apparent gender presentation (masculine, feminine, androgynous, non-human)',
  '- Body type and proportions (slender, athletic, stocky, exaggerated proportions)',
  '- Clothing style and notable garments (casual, formal, fantasy armor, uniform, etc.)',
  '- Any notable accessories (glasses, hats, jewelry, wings, tails, etc.)',
  '- Overall character vibe or archetype (friendly assistant, fantasy warrior, business professional, etc.)',
  '',
  'Keep the description to 2-3 sentences that capture the essential character traits.',
  'Focus on aspects that would affect how the character should move and gesture.',
  'For example, a formal business character should have more restrained gestures,',
  'while an energetic anime character could have more exaggerated movements.',
].join('\n');

export class AvatarDescriptionService {
  private readonly client: OpenAI;
  private readonly logger?: AvatarDescriptionServiceOptions['logger'];

  constructor(options: AvatarDescriptionServiceOptions) {
    this.client = options.client;
    this.logger = options.logger;
  }

  async generateDescription(thumbnailDataUrl: string): Promise<string> {
    if (!thumbnailDataUrl || !thumbnailDataUrl.startsWith('data:image/')) {
      throw new Error('Invalid thumbnail data URL provided.');
    }

    const input: ResponseInput = [
      {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: DESCRIPTION_SYSTEM_PROMPT }],
      },
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'Please describe this 3D avatar character:',
          },
          {
            type: 'input_image',
            image_url: thumbnailDataUrl,
          },
        ],
      },
    ];

    try {
      const response = await (
        this.client as unknown as {
          responses: { create: (args: unknown) => Promise<{ output_text: string }> };
        }
      ).responses.create({
        model: 'gpt-4.1-mini',
        input,
      });

      const description = response?.output_text?.trim() ?? '';
      if (!description) {
        throw new Error('Avatar description generation returned an empty response.');
      }

      this.logger?.info?.('Avatar description generated.', { descriptionLength: description.length });
      return description;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.error?.('Failed to generate avatar description.', { error: message });
      throw error;
    }
  }
}
