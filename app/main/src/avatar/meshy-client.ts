import type {
  MeshyModelGenerationRequest,
  MeshyModelGenerationResult,
  MeshyModelStatus,
  MeshyJobStatus,
} from './types.js';

export interface MeshyClientLogger {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  error?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface MeshyClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetcher?: typeof fetch;
  logger?: MeshyClientLogger;
}

const DEFAULT_BASE_URL = 'https://api.meshy.ai';

const ensureString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const ensureNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const normalizeProgress = (value: unknown): number | undefined => {
  const numeric = ensureNumber(value);
  if (typeof numeric !== 'number') {
    return undefined;
  }

  if (numeric <= 1 && numeric >= 0) {
    return Math.round(numeric * 100);
  }

  return numeric;
};

const normalizeStatus = (value: unknown): MeshyJobStatus => {
  const normalized = ensureString(value)?.toLowerCase() ?? '';

  if (['queued', 'pending', 'waiting'].includes(normalized)) {
    return 'queued';
  }

  if (['generating', 'processing', 'in_progress', 'running'].includes(normalized)) {
    return 'generating';
  }

  if (['rigging', 'rig', 'skinning'].includes(normalized)) {
    return 'rigging';
  }

  if (['completed', 'done', 'succeeded', 'success'].includes(normalized)) {
    return 'completed';
  }

  if (['failed', 'error', 'cancelled', 'canceled'].includes(normalized)) {
    return 'failed';
  }

  return 'queued';
};

const pickFirstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    const candidate = ensureString(value);
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
};

const pickFirstValue = (...values: unknown[]): unknown => {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return undefined;
};

const readNestedValue = (value: unknown, path: string[]): unknown => {
  return path.reduce<unknown>((acc, key) => {
    if (!acc || typeof acc !== 'object') {
      return undefined;
    }
    return (acc as Record<string, unknown>)[key];
  }, value);
};

const trimMessage = (value: unknown): string | undefined => {
  const message = ensureString(value);
  if (!message) {
    return undefined;
  }

  return message.slice(0, 500);
};

export class MeshyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly logger?: MeshyClientLogger;

  constructor(options: MeshyClientOptions) {
    if (!options.apiKey || !options.apiKey.trim()) {
      throw new Error('Meshy API key is required.');
    }

    this.apiKey = options.apiKey.trim();
    this.baseUrl = options.baseUrl?.trim() || DEFAULT_BASE_URL;
    this.fetcher = options.fetcher ?? fetch;
    this.logger = options.logger;
  }

  async createGenerationJob(request: MeshyModelGenerationRequest): Promise<MeshyModelGenerationResult> {
    if (!request?.prompt?.trim()) {
      throw new Error('Meshy model generation prompt is required.');
    }

    const payload = {
      prompt: request.prompt.trim(),
      model_format: 'fbx',
      rig: true,
    };

    this.logger?.info?.('Meshy generation job requested.', {
      promptLength: payload.prompt.length,
    });

    const responseBody = await this.requestJson('/v1/text-to-3d', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const jobId =
      pickFirstString(
        (responseBody as Record<string, unknown> | null)?.id,
        (responseBody as Record<string, unknown> | null)?.job_id,
        (responseBody as Record<string, unknown> | null)?.jobId,
      ) ?? '';

    if (!jobId) {
      this.logger?.error?.('Meshy generation response missing job ID.', { responseBody });
      throw new Error('Meshy generation response missing job ID.');
    }

    return { jobId };
  }

  async getJobStatus(jobId: string): Promise<MeshyModelStatus> {
    if (!jobId.trim()) {
      throw new Error('Meshy job ID is required.');
    }

    const responseBody = await this.requestJson(`/v1/text-to-3d/${jobId}`, {
      method: 'GET',
    });

    const body = responseBody as Record<string, unknown>;
    const status = normalizeStatus(
      pickFirstString(body.status, body.state, body.stage, body.phase),
    );

    const progress = normalizeProgress(
      pickFirstValue(body.progress, body.progress_percent, body.progressPercent, body.percentage),
    );

    const previewUrl = pickFirstString(
      body.preview_url,
      body.previewUrl,
      body.preview_image_url,
      body.previewImageUrl,
      readNestedValue(body, ['preview', 'url']),
      readNestedValue(body, ['preview', 'href']),
      readNestedValue(body, ['outputs', 'preview']),
      readNestedValue(body, ['model_urls', 'preview']),
    );

    const fbxUrl = pickFirstString(
      body.fbx_url,
      body.fbxUrl,
      readNestedValue(body, ['outputs', 'fbx']),
      readNestedValue(body, ['model_urls', 'fbx']),
    );

    const errorMessage = trimMessage(
      pickFirstString(
        readNestedValue(body, ['error', 'message']),
        readNestedValue(body, ['error', 'detail']),
        body.message,
      ),
    );

    return {
      jobId,
      status,
      ...(typeof progress === 'number' ? { progress } : {}),
      previewPath: previewUrl ?? null,
      fbxPath: fbxUrl ?? null,
      errorMessage: errorMessage ?? null,
    };
  }

  async downloadAsset(url: string, destinationPath: string): Promise<{ bytes: number }> {
    if (!url.trim()) {
      throw new Error('Meshy asset URL is required.');
    }

    if (!destinationPath.trim()) {
      throw new Error('Meshy asset destination path is required.');
    }

    const response = await this.fetcher(url, {
      headers: this.buildHeaders(),
    });

    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (!response.ok) {
      const text = await response.text();
      this.logger?.error?.('Meshy asset download failed.', {
        url,
        status: response.status,
        detail: trimMessage(text),
      });
      throw new Error(`Meshy asset download failed: HTTP ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    await this.persistFile(destinationPath, buffer);

    this.logger?.info?.('Meshy asset downloaded.', {
      url,
      bytes: buffer.length,
      contentLength: Number.isFinite(contentLength) ? contentLength : undefined,
      destinationPath,
    });

    return { bytes: buffer.length };
  }

  private buildHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
    };
  }

  private async requestJson(path: string, init: RequestInit): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const response = await this.fetcher(url, {
      ...init,
      headers: {
        ...this.buildHeaders(),
        ...(init.headers ?? {}),
      },
    });

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    let responseBody: unknown = null;
    let rawText: string | undefined;

    try {
      if (contentType.includes('application/json')) {
        responseBody = await response.json();
      } else {
        rawText = await response.text();
      }
    } catch (error) {
      this.logger?.warn?.('Failed to parse Meshy response body.', {
        url,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    if (!response.ok) {
      const detail =
        typeof responseBody === 'object' && responseBody && 'error' in responseBody
          ? JSON.stringify((responseBody as { error?: unknown }).error)
          : rawText;
      this.logger?.error?.('Meshy API request failed.', {
        url,
        status: response.status,
        detail: detail ? detail.slice(0, 500) : undefined,
      });
      throw new Error(`Meshy API request failed: HTTP ${response.status}`);
    }

    return responseBody;
  }

  private async persistFile(destinationPath: string, buffer: Buffer): Promise<void> {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');

    await mkdir(dirname(destinationPath), { recursive: true });
    await writeFile(destinationPath, buffer);
  }
}
