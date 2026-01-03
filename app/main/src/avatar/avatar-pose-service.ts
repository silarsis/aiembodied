
import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { mkdir, readFile as fsReadFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryStore, VrmPoseRecord } from '../memory/memory-store.js';
import type {
    AvatarPoseSummary,
    AvatarPoseUploadRequest,
    AvatarPoseUploadResult,
} from './types.js';

interface FileSystemAdapter {
    mkdir: (target: string) => Promise<void>;
    writeFile: (target: string, data: Buffer) => Promise<void>;
    rm: (target: string) => Promise<void>;
    readFile: (target: string) => Promise<Buffer>;
}

interface AvatarPoseServiceOptions {
    store: MemoryStore;
    posesDirectory: string;
    now?: () => number;
    logger?: {
        debug?: (message: string, meta?: Record<string, unknown>) => void;
        info?: (message: string, meta?: Record<string, unknown>) => void;
        warn?: (message: string, meta?: Record<string, unknown>) => void;
        error?: (message: string, meta?: Record<string, unknown>) => void;
    };
    fs?: FileSystemAdapter;
}

function sanitizeName(name: string | undefined, fallback: string): string {
    if (typeof name !== 'string') {
        return fallback;
    }

    const trimmed = name.trim();
    if (!trimmed) {
        return fallback;
    }

    return trimmed.slice(0, 200);
}

const defaultFs: FileSystemAdapter = {
    mkdir: async (target) => {
        await mkdir(target, { recursive: true });
    },
    writeFile: async (target, data) => {
        await writeFile(target, data);
    },
    rm: async (target) => {
        await rm(target, { force: true });
    },
    readFile: async (target) => {
        return await fsReadFile(target);
    },
};

export class AvatarPoseService {
    private readonly store: MemoryStore;
    private readonly posesDirectory: string;
    private readonly now: () => number;
    private readonly logger?: AvatarPoseServiceOptions['logger'];
    private readonly fs: FileSystemAdapter;

    constructor(options: AvatarPoseServiceOptions) {
        this.store = options.store;
        this.posesDirectory = path.resolve(options.posesDirectory);
        this.now = options.now ?? Date.now;
        this.logger = options.logger;
        this.fs = options.fs ?? defaultFs;
    }

    listPoses(): AvatarPoseSummary[] {
        return this.store.listVrmPoses().map((record) => this.toSummary(record));
    }

    async loadPose(poseId: string): Promise<unknown> {
        const record = this.store.getVrmPose(poseId);
        if (!record) {
            throw new Error('Requested VRM pose is not available.');
        }

        try {
            const buffer = await this.fs.readFile(record.filePath);
            if (buffer.length === 0) {
                throw new Error('VRM pose file is empty.');
            }

            return JSON.parse(buffer.toString('utf8'));
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger?.error?.('Failed to load VRM pose file.', {
                poseId,
                filePath: record.filePath,
                message,
            });
            throw new Error('Failed to load VRM pose file from disk.');
        }
    }

    async uploadPose(request: AvatarPoseUploadRequest): Promise<AvatarPoseUploadResult> {
        if (!request || typeof request.fileName !== 'string' || typeof request.data !== 'string') {
            throw new Error('Invalid VRM pose upload payload.');
        }

        const fileName = request.fileName.trim();
        if (!fileName.toLowerCase().endsWith('.pose.json')) {
            throw new Error('VRM pose upload rejected: file must use the .pose.json extension.');
        }

        const jsonString = request.data.trim();
        let parsed: unknown;
        try {
            parsed = JSON.parse(jsonString);
        } catch {
            throw new Error('VRM pose upload rejected: invalid JSON data.');
        }

        if (!parsed || typeof parsed !== 'object') {
            throw new Error('VRM pose upload rejected: JSON data must be an object.');
        }

        const buffer = Buffer.from(jsonString, 'utf8');

        const baseName = path.parse(fileName).name.replace('.pose', '') || 'VRM Pose';
        const name = sanitizeName(request.name, baseName);
        const id = randomUUID();
        const filePath = path.join(this.posesDirectory, `${id}.pose.json`);
        const createdAt = this.now();
        const fileSha = createHash('sha256').update(buffer).digest('hex');

        try {
            await this.fs.mkdir(this.posesDirectory);
            await this.fs.writeFile(filePath, buffer);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.logger?.error?.('Failed to persist VRM pose file.', { message, filePath });
            throw new Error('Failed to persist VRM pose file to disk.');
        }

        const record: VrmPoseRecord = {
            id,
            name,
            createdAt,
            filePath,
            fileSha,
        };

        try {
            this.store.createVrmPose(record);
        } catch (error) {
            await this.fs.rm(filePath).catch(() => {
                this.logger?.warn?.('Failed to clean up VRM pose file after store write failure.', { filePath });
            });
            throw error;
        }

        this.logger?.info?.('VRM pose uploaded successfully.', { id, filePath });
        return { pose: this.toSummary(record) };
    }

    async deletePose(poseId: string): Promise<void> {
        const record = this.store.getVrmPose(poseId);
        if (!record) {
            this.logger?.warn?.('Attempted to delete missing VRM pose.', { poseId });
            return;
        }

        this.store.deleteVrmPose(poseId);

        await this.fs.rm(record.filePath).catch((error) => {
            const message = error instanceof Error ? error.message : String(error);
            this.logger?.warn?.('Failed to remove VRM pose file from disk.', {
                poseId,
                filePath: record.filePath,
                message,
            });
        });

        this.logger?.info?.('VRM pose removed.', { poseId });
    }

    private toSummary(record: VrmPoseRecord): AvatarPoseSummary {
        return {
            id: record.id,
            name: record.name,
            createdAt: record.createdAt,
            fileSha: record.fileSha,
        };
    }
}
