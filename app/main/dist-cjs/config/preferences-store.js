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
        const preferences = {};
        if (audioInputDeviceId) {
            preferences.audioInputDeviceId = audioInputDeviceId;
        }
        if (audioOutputDeviceId) {
            preferences.audioOutputDeviceId = audioOutputDeviceId;
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
