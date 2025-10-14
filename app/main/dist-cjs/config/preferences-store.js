"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemoryPreferencesStore = exports.FilePreferencesStore = void 0;
const node_fs_1 = require("node:fs");
const node_path_1 = __importDefault(require("node:path"));
class FilePreferencesStore {
    constructor(filePath) {
        this.filePath = filePath;
    }
    async load() {
        try {
            const raw = await node_fs_1.promises.readFile(this.filePath, 'utf8');
            const parsed = JSON.parse(raw);
            return this.sanitize(parsed);
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return {};
            }
            throw error;
        }
    }
    async save(preferences) {
        const directory = node_path_1.default.dirname(this.filePath);
        await node_fs_1.promises.mkdir(directory, { recursive: true });
        const payload = JSON.stringify(preferences, null, 2);
        await node_fs_1.promises.writeFile(this.filePath, payload, 'utf8');
    }
    sanitize(input) {
        const audioInputDeviceId = this.normalizeId(input.audioInputDeviceId);
        const audioOutputDeviceId = this.normalizeId(input.audioOutputDeviceId);
        const realtimeModel = this.normalizeId(input.realtimeModel);
        const realtimeVoice = this.normalizeId(input.realtimeVoice);
        const sessionInstructions = this.normalizeId(input.sessionInstructions);
        const vadTurnDetection = this.normalizeTurnDetection(input.vadTurnDetection);
        const vadThreshold = this.normalizeNumber(input.vadThreshold, 0, 1);
        const vadSilenceDurationMs = this.normalizeInt(input.vadSilenceDurationMs, 0, 10000);
        const vadMinSpeechDurationMs = this.normalizeInt(input.vadMinSpeechDurationMs, 0, 10000);
        const preferences = {};
        if (audioInputDeviceId) {
            preferences.audioInputDeviceId = audioInputDeviceId;
        }
        if (audioOutputDeviceId) {
            preferences.audioOutputDeviceId = audioOutputDeviceId;
        }
        if (realtimeModel) {
            preferences.realtimeModel = realtimeModel;
        }
        if (realtimeVoice) {
            preferences.realtimeVoice = realtimeVoice;
        }
        if (sessionInstructions) {
            preferences.sessionInstructions = sessionInstructions;
        }
        if (vadTurnDetection) {
            preferences.vadTurnDetection = vadTurnDetection;
        }
        if (typeof vadThreshold === 'number') {
            preferences.vadThreshold = vadThreshold;
        }
        if (typeof vadSilenceDurationMs === 'number') {
            preferences.vadSilenceDurationMs = vadSilenceDurationMs;
        }
        if (typeof vadMinSpeechDurationMs === 'number') {
            preferences.vadMinSpeechDurationMs = vadMinSpeechDurationMs;
        }
        return preferences;
    }
    normalizeId(value) {
        if (typeof value !== 'string') {
            return undefined;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    normalizeTurnDetection(value) {
        if (value === 'none' || value === 'server_vad')
            return value;
        if (typeof value === 'string') {
            const v = value.trim().toLowerCase();
            if (v === 'none' || v === 'server_vad')
                return v;
        }
        return undefined;
    }
    normalizeNumber(value, min, max) {
        const n = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(n))
            return undefined;
        if (n < min || n > max)
            return undefined;
        return n;
    }
    normalizeInt(value, min, max) {
        const n = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(n))
            return undefined;
        const i = Math.round(n);
        if (i < min || i > max)
            return undefined;
        return i;
    }
}
exports.FilePreferencesStore = FilePreferencesStore;
class InMemoryPreferencesStore {
    constructor() {
        this.preferences = {};
    }
    async load() {
        return { ...this.preferences };
    }
    async save(preferences) {
        this.preferences = { ...preferences };
    }
}
exports.InMemoryPreferencesStore = InMemoryPreferencesStore;
