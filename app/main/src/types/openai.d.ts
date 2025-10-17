declare module 'openai' {
  export interface OpenAIOptions {
    apiKey: string;
  }

  export default class OpenAI {
    constructor(options: OpenAIOptions);
    responses: {
      create: (params: unknown) => Promise<unknown>;
    };
  }
}

declare module 'openai/resources/responses/responses' {
  export type ResponseInputMessageContentList = Array<
    | { type: 'input_text'; text: string }
    | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' }
  >;

  export type ResponseInput = Array<{
    type: 'message';
    role: 'system' | 'user';
    content: ResponseInputMessageContentList;
  }>;

  export interface ResponseCreateParamsNonStreaming {
    model: string;
    input: ResponseInput;
  }
}
