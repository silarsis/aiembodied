"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConfigManager = exports.ConfigValidationError = void 0;
const node_path_1 = __importDefault(require("node:path"));
const zod_1 = require("zod");
const porcupine_node_1 = require("@picovoice/porcupine-node");
class ConfigValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ConfigValidationError';
    }
}
exports.ConfigValidationError = ConfigValidationError;
const FeatureFlagsSchema = zod_1.z.record(zod_1.z.string().min(1), zod_1.z.boolean());
const WakeWordSchema = zod_1.z.object({
    accessKey: zod_1.z.string().min(1, 'Porcupine access key is required'),
    keywordPath: zod_1.z.string().min(1, 'Wake word keyword path is required'),
    keywordLabel: zod_1.z.string().min(1, 'Wake word keyword label is required'),
    sensitivity: zod_1.z.number().min(0).max(1),
    minConfidence: zod_1.z.number().min(0).max(1),
    cooldownMs: zod_1.z.number().int().min(0),
    deviceIndex: zod_1.z.number().int().optional(),
    modelPath: zod_1.z.string().min(1).optional(),
});
const MetricsSchema = zod_1.z.object({
    enabled: zod_1.z.boolean(),
    host: zod_1.z.string().min(1),
    port: zod_1.z.number().int().min(1).max(65535),
    path: zod_1.z
        .string()
        .min(1)
        .transform((value) => (value.startsWith('/') ? value : `/${value}`)),
});
const RealtimeApiKeySchema = zod_1.z.string().min(1, 'Realtime API key is required');
const WakeWordAccessKeySchema = zod_1.z.string().min(1, 'Porcupine access key is required');
const DEFAULT_SECRET_KEYS = ['realtimeApiKey', 'wakeWordAccessKey'];
class ConfigManager {
    constructor(options = {}) {
        this.config = null;
        this.secretTestTimeoutMs = 5000;
        this.secretStore = options.secretStore;
        this.preferencesStore = options.preferencesStore;
        this.env = options.env ?? process.env;
        this.fetchFn = options.fetchFn ?? (typeof fetch === 'function' ? fetch : undefined);
        this.realtimeTestEndpoint = options.realtimeTestEndpoint ?? 'https://api.openai.com/v1/models';
        this.wakeWordTestEndpoint = options.wakeWordTestEndpoint ??
            'https://api.picovoice.ai/api/v1/porcupine/validate';
        this.logger = options.logger ?? console;
    }
    async load() {
        if (this.config) {
            this.logger.debug('Configuration already loaded. Returning cached state.');
            return this.config;
        }
        this.logger.info('Loading configuration from environment and secret stores.');
        const realtimeApiKey = await this.resolveRealtimeApiKey();
        const wakeWordAccessKey = await this.resolveWakeWordAccessKey();
        const storedPreferences = (await this.preferencesStore?.load()) ?? {};
        if (!wakeWordAccessKey) {
            throw new ConfigValidationError('Porcupine access key is required. Provide PORCUPINE_ACCESS_KEY in the environment or store it securely.');
        }
        const audioInputDeviceId = this.normalizeDeviceId(storedPreferences.audioInputDeviceId) ??
            this.normalizeDeviceId(this.env.AUDIO_INPUT_DEVICE_ID);
        const audioOutputDeviceId = this.normalizeDeviceId(storedPreferences.audioOutputDeviceId) ??
            this.normalizeDeviceId(this.env.AUDIO_OUTPUT_DEVICE_ID);
        const config = {
            realtimeApiKey: realtimeApiKey ?? '',
            audioInputDeviceId,
            audioOutputDeviceId,
            realtimeModel: this.normalizeDeviceId(storedPreferences.realtimeModel),
            featureFlags: this.parseFeatureFlags(this.env.FEATURE_FLAGS),
            wakeWord: this.parseWakeWordConfig({ accessKey: wakeWordAccessKey }),
            metrics: this.parseMetricsConfig(),
        };
        this.config = config;
        this.logger.info('Configuration loaded.', {
            hasRealtimeApiKey: Boolean(config.realtimeApiKey),
            wakeWordHasAccessKey: Boolean(config.wakeWord.accessKey),
            audioInputConfigured: Boolean(config.audioInputDeviceId),
            audioOutputConfigured: Boolean(config.audioOutputDeviceId),
            featureFlagCount: Object.keys(config.featureFlags ?? {}).length,
        });
        return config;
    }
    async setAudioDevicePreferences(preferences) {
        if (!this.config) {
            throw new Error('ConfigManager.load() must be called before updating preferences.');
        }
        const audioInputDeviceId = this.normalizeDeviceId(preferences.audioInputDeviceId);
        const audioOutputDeviceId = this.normalizeDeviceId(preferences.audioOutputDeviceId);
        const realtimeModel = this.normalizeDeviceId(preferences.realtimeModel);
        this.config = {
            ...this.config,
            audioInputDeviceId,
            audioOutputDeviceId,
            ...(typeof realtimeModel === 'string' ? { realtimeModel } : {}),
        };
        await this.preferencesStore?.save({ audioInputDeviceId, audioOutputDeviceId, realtimeModel });
        return this.getRendererConfig();
    }
    getConfig() {
        if (!this.config) {
            throw new Error('ConfigManager.load() must be called before accessing the config.');
        }
        return this.config;
    }
    getRendererConfig() {
        const config = this.getConfig();
        const { realtimeApiKey, wakeWord, ...rest } = config;
        const { accessKey, ...rendererWakeWord } = wakeWord;
        return {
            ...rest,
            hasRealtimeApiKey: Boolean(realtimeApiKey),
            wakeWord: {
                ...rendererWakeWord,
                hasAccessKey: Boolean(accessKey),
            },
        };
    }
    async getSecret(key) {
        if (!DEFAULT_SECRET_KEYS.includes(key)) {
            throw new Error(`Unknown secret key requested: ${key}`);
        }
        const config = this.getConfig();
        if (key === 'realtimeApiKey') {
            return config.realtimeApiKey;
        }
        if (key === 'wakeWordAccessKey') {
            return config.wakeWord.accessKey;
        }
        throw new Error(`Unhandled secret key requested: ${key}`);
    }
    async setSecret(key, value) {
        if (!this.config) {
            throw new Error('ConfigManager.load() must be called before updating secrets.');
        }
        const trimmed = typeof value === 'string' ? value.trim() : '';
        if (key === 'realtimeApiKey') {
            const parsed = RealtimeApiKeySchema.parse(trimmed);
            await this.persistSecret('REALTIME_API_KEY', parsed);
            this.config = {
                ...this.config,
                realtimeApiKey: parsed,
            };
            this.logger.info('Realtime API key updated.', { length: parsed.length });
            return this.getRendererConfig();
        }
        if (key === 'wakeWordAccessKey') {
            const parsed = WakeWordAccessKeySchema.parse(trimmed);
            await this.persistSecret('PORCUPINE_ACCESS_KEY', parsed);
            this.config = {
                ...this.config,
                wakeWord: {
                    ...this.config.wakeWord,
                    accessKey: parsed,
                },
            };
            this.logger.info('Wake word access key updated.', { length: parsed.length });
            return this.getRendererConfig();
        }
        throw new Error(`Unhandled secret key update requested: ${key}`);
    }
    async testSecret(key) {
        if (!this.config) {
            throw new Error('ConfigManager.load() must be called before testing secrets.');
        }
        const fetchFn = this.fetchFn;
        if (!fetchFn) {
            return { ok: false, message: 'Secret testing is unavailable: no HTTP client configured.' };
        }
        if (key === 'realtimeApiKey') {
            if (!this.config.realtimeApiKey) {
                return { ok: false, message: 'Realtime API key is not configured.' };
            }
            this.logger.debug('Testing realtime API key.');
            return this.testRealtimeKey(fetchFn, this.config.realtimeApiKey);
        }
        if (key === 'wakeWordAccessKey') {
            if (!this.config.wakeWord.accessKey) {
                return { ok: false, message: 'Porcupine access key is not configured.' };
            }
            this.logger.debug('Testing wake word access key.');
            return this.testWakeWordKey(fetchFn, this.config.wakeWord.accessKey);
        }
        throw new Error(`Unhandled secret test requested: ${key}`);
    }
    async resolveRealtimeApiKey() {
        this.logger.debug('Resolving realtime API key from environment variables.', {
            keys: ['REALTIME_API_KEY', 'realtime_api_key'],
        });
        const envValue = this.readSecretFromEnv(['REALTIME_API_KEY', 'realtime_api_key']);
        if (envValue) {
            this.logger.debug('Realtime API key resolved from environment variables.', {
                length: envValue.length,
            });
            return envValue;
        }
        this.logger.debug('Realtime API key not found in environment.', {
            hasSecretStore: Boolean(this.secretStore),
        });
        if (!this.secretStore) {
            this.logger.warn('Realtime API key unavailable: secret store is not configured.');
            return undefined;
        }
        const stored = await this.secretStore.getSecret('REALTIME_API_KEY');
        if (stored) {
            this.logger.debug('Realtime API key resolved from secret store.', { length: stored.length });
        }
        else {
            this.logger.warn('Realtime API key not found in secret store.');
        }
        return stored ?? undefined;
    }
    async resolveWakeWordAccessKey() {
        this.logger.debug('Resolving wake word access key from environment variables.', {
            keys: ['PORCUPINE_ACCESS_KEY', 'porcupine_access_key'],
        });
        const envValue = this.readSecretFromEnv(['PORCUPINE_ACCESS_KEY', 'porcupine_access_key']);
        if (envValue) {
            this.logger.debug('Wake word access key resolved from environment variables.', {
                length: envValue.length,
            });
            return envValue;
        }
        this.logger.debug('Wake word access key not found in environment.', {
            hasSecretStore: Boolean(this.secretStore),
        });
        if (!this.secretStore) {
            this.logger.error('Wake word access key unavailable: secret store is not configured.');
            return undefined;
        }
        const stored = await this.secretStore.getSecret('PORCUPINE_ACCESS_KEY');
        if (stored) {
            this.logger.debug('Wake word access key resolved from secret store.', { length: stored.length });
        }
        else {
            this.logger.error('Wake word access key not found in secret store.');
        }
        return stored ?? undefined;
    }
    readSecretFromEnv(keys) {
        for (const key of keys) {
            const value = this.env[key];
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed) {
                    return trimmed;
                }
            }
        }
        return undefined;
    }
    async persistSecret(key, value) {
        if (!this.secretStore) {
            throw new Error('Secret store is not configured. Unable to persist secrets securely.');
        }
        await this.secretStore.setSecret(key, value);
    }
    createTimeoutSignal() {
        if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
            return AbortSignal.timeout(this.secretTestTimeoutMs);
        }
        if (typeof AbortController !== 'undefined') {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), this.secretTestTimeoutMs);
            if (typeof timeout === 'object' && typeof timeout.unref === 'function') {
                timeout.unref();
            }
            return controller.signal;
        }
        return undefined;
    }
    async testRealtimeKey(fetchFn, key) {
        try {
            const response = await fetchFn(this.realtimeTestEndpoint, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${key}`,
                },
                signal: this.createTimeoutSignal(),
            });
            if (!response.ok) {
                return {
                    ok: false,
                    message: `Realtime API responded with HTTP ${response.status}`,
                };
            }
            return { ok: true, message: 'Realtime API key verified successfully.' };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error while testing realtime API key.';
            return { ok: false, message };
        }
    }
    async testWakeWordKey(fetchFn, key) {
        try {
            const response = await fetchFn(this.wakeWordTestEndpoint, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${key}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ operation: 'validate' }),
                signal: this.createTimeoutSignal(),
            });
            if (!response.ok) {
                return {
                    ok: false,
                    message: `Wake word service responded with HTTP ${response.status}`,
                };
            }
            return { ok: true, message: 'Porcupine access key verified successfully.' };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error while testing Porcupine access key.';
            return { ok: false, message };
        }
    }
    parseMetricsConfig() {
        const enabledValue = this.env.METRICS_ENABLED?.trim();
        const enabled = enabledValue ? ['1', 'true', 'yes', 'on'].includes(enabledValue.toLowerCase()) : false;
        const host = this.env.METRICS_HOST?.trim() || '127.0.0.1';
        const path = this.env.METRICS_PATH?.trim() || '/metrics';
        const portValue = this.env.METRICS_PORT?.trim();
        const port = portValue ? Number.parseInt(portValue, 10) : 9477;
        if (Number.isNaN(port)) {
            throw new ConfigValidationError('METRICS_PORT must be a valid integer if specified.');
        }
        return MetricsSchema.parse({ enabled, host, port, path });
    }
    parseFeatureFlags(raw) {
        if (!raw) {
            return {};
        }
        const trimmed = raw.trim();
        if (!trimmed) {
            return {};
        }
        try {
            const parsed = JSON.parse(trimmed);
            return FeatureFlagsSchema.parse(parsed);
        }
        catch (error) {
            // fall back to comma-separated parsing
        }
        const flags = {};
        for (const token of trimmed.split(',')) {
            const segment = token.trim();
            if (!segment) {
                continue;
            }
            const [rawKey, rawValue] = segment.split('=');
            const key = rawKey?.trim();
            if (!key) {
                continue;
            }
            const value = rawValue?.trim().toLowerCase();
            flags[key] = value === undefined || value === '' ? true : ['1', 'true', 'on', 'yes', 'enabled'].includes(value);
        }
        return FeatureFlagsSchema.parse(flags);
    }
    normalizeDeviceId(value) {
        if (typeof value !== 'string') {
            return undefined;
        }
        const trimmed = value.trim();
        return trimmed.length > 0 ? trimmed : undefined;
    }
    parseWakeWordConfig({ accessKey }) {
        const keywordPath = this.resolveKeywordPath();
        const keywordLabel = this.resolveKeywordLabel(keywordPath);
        const sensitivity = this.parseNumberInRange({
            name: 'WAKE_WORD_SENSITIVITY',
            raw: this.env.WAKE_WORD_SENSITIVITY,
            defaultValue: 0.6,
            min: 0,
            max: 1,
        });
        const minConfidence = this.parseNumberInRange({
            name: 'WAKE_WORD_MIN_CONFIDENCE',
            raw: this.env.WAKE_WORD_MIN_CONFIDENCE,
            defaultValue: 0.5,
            min: 0,
            max: 1,
        });
        const cooldownMs = this.parseInteger({
            name: 'WAKE_WORD_COOLDOWN_MS',
            raw: this.env.WAKE_WORD_COOLDOWN_MS,
            defaultValue: 1500,
            min: 0,
        });
        const deviceIndex = this.parseOptionalInteger({
            name: 'WAKE_WORD_DEVICE_INDEX',
            raw: this.env.WAKE_WORD_DEVICE_INDEX,
        });
        const modelPath = this.env.WAKE_WORD_MODEL_PATH?.trim() || undefined;
        return WakeWordSchema.parse({
            accessKey,
            keywordPath,
            keywordLabel,
            sensitivity,
            minConfidence,
            cooldownMs,
            deviceIndex,
            modelPath,
        });
    }
    resolveKeywordPath() {
        const explicitPath = this.env.WAKE_WORD_KEYWORD_PATH?.trim();
        if (explicitPath) {
            return node_path_1.default.resolve(explicitPath);
        }
        const builtin = this.env.WAKE_WORD_BUILTIN?.trim();
        const keyword = this.resolveBuiltinKeyword(builtin);
        return keyword;
    }
    resolveKeywordLabel(keywordPath) {
        const label = this.env.WAKE_WORD_KEYWORD_LABEL?.trim();
        if (label) {
            return label;
        }
        const builtinKeyword = this.getBuiltinKeywordIfValid(keywordPath);
        if (builtinKeyword) {
            return this.formatKeywordLabel(builtinKeyword);
        }
        const base = node_path_1.default.basename(keywordPath);
        const withoutExtension = base.replace(node_path_1.default.extname(base), '');
        return withoutExtension;
    }
    resolveBuiltinKeyword(input) {
        if (!input) {
            return porcupine_node_1.BuiltinKeyword.PORCUPINE;
        }
        const normalized = input.trim().toLowerCase();
        const match = Object.values(porcupine_node_1.BuiltinKeyword).find((keyword) => keyword.toLowerCase() === normalized);
        if (!match) {
            throw new ConfigValidationError(`Unknown wake word builtin keyword: ${input}`);
        }
        return match;
    }
    getBuiltinKeywordIfValid(keywordPath) {
        if (Object.values(porcupine_node_1.BuiltinKeyword).includes(keywordPath)) {
            return keywordPath;
        }
        return null;
    }
    formatKeywordLabel(keyword) {
        return keyword
            .split(' ')
            .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
            .join(' ');
    }
    parseNumberInRange({ name, raw, defaultValue, min, max, }) {
        if (raw === undefined || raw === '') {
            return defaultValue;
        }
        const value = Number(raw);
        if (!Number.isFinite(value)) {
            throw new ConfigValidationError(`${name} must be a number.`);
        }
        if (value < min || value > max) {
            throw new ConfigValidationError(`${name} must be between ${min} and ${max}.`);
        }
        return value;
    }
    parseInteger({ name, raw, defaultValue, min, }) {
        if (raw === undefined || raw === '') {
            return defaultValue;
        }
        const value = Number.parseInt(raw, 10);
        if (!Number.isFinite(value)) {
            throw new ConfigValidationError(`${name} must be an integer.`);
        }
        if (value < min) {
            throw new ConfigValidationError(`${name} must be greater than or equal to ${min}.`);
        }
        return value;
    }
    parseOptionalInteger({ name, raw, }) {
        if (raw === undefined || raw === '') {
            return undefined;
        }
        const value = Number.parseInt(raw, 10);
        if (!Number.isFinite(value)) {
            throw new ConfigValidationError(`${name} must be an integer.`);
        }
        return value;
    }
}
exports.ConfigManager = ConfigManager;
