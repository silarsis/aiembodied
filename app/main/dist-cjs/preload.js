"use strict";
import { contextBridge, ipcRenderer } from 'electron';
function logPreloadMessage(level, message, meta) {
    const prefix = `[preload bridge] ${message}`;
    try {
        if (meta) {
            if (level === 'info') {
                console.info(prefix, meta);
            }
            else if (level === 'warn') {
                console.warn(prefix, meta);
            }
            else {
                console.error(prefix, meta);
            }
        }
        else if (level === 'info') {
            console.info(prefix);
        }
        else if (level === 'warn') {
            console.warn(prefix);
        }
        else {
            console.error(prefix);
        }
    }
    catch {
        // Ignore logging errors — console may be unavailable in some contexts.
    }
}
function forwardPreloadDiagnostics(level, message, meta) {
    try {
        ipcRenderer.send('diagnostics:preload-log', {
            level,
            message,
            meta,
            ts: Date.now(),
        });
    }
    catch {
        // ignore IPC forwarding errors
    }
}
const logPreloadInfo = (message, meta) => {
    logPreloadMessage('info', message, meta);
    forwardPreloadDiagnostics('info', message, meta);
};
const logPreloadError = (message, meta) => {
    logPreloadMessage('error', message, meta);
    forwardPreloadDiagnostics('error', message, meta);
};
const api = {
    config: {
        get: () => ipcRenderer.invoke('config:get'),
        getSecret: (key) => ipcRenderer.invoke('config:get-secret', key),
        setSecret: (key, value) => ipcRenderer.invoke('config:set-secret', { key, value }),
        testSecret: (key) => ipcRenderer.invoke('config:test-secret', key),
        setAudioDevicePreferences: (preferences) => ipcRenderer.invoke('config:set-audio-devices', preferences),
    },
    wakeWord: {
        onWake: (listener) => {
            const channel = 'wake-word:event';
            const handler = (_event, payload) => listener(payload);
            ipcRenderer.on(channel, handler);
            return () => {
                ipcRenderer.removeListener(channel, handler);
            };
        },
    },
    conversation: {
        getHistory: () => ipcRenderer.invoke('conversation:get-history'),
        appendMessage: (message) => ipcRenderer.invoke('conversation:append-message', message),
        onSessionStarted: (listener) => {
            const channel = 'conversation:session-started';
            const handler = (_event, payload) => listener(payload);
            ipcRenderer.on(channel, handler);
            return () => {
                ipcRenderer.removeListener(channel, handler);
            };
        },
        onMessageAppended: (listener) => {
            const channel = 'conversation:message-appended';
            const handler = (_event, payload) => listener(payload);
            ipcRenderer.on(channel, handler);
            return () => {
                ipcRenderer.removeListener(channel, handler);
            };
        },
    },
    metrics: {
        observeLatency: async (metric, valueMs) => {
            await ipcRenderer.invoke('metrics:observe-latency', { metric, valueMs });
        },
    },
    avatar: {
        listFaces: () => ipcRenderer.invoke('avatar:list-faces'),
        getActiveFace: () => ipcRenderer.invoke('avatar:get-active-face'),
        setActiveFace: (faceId) => ipcRenderer.invoke('avatar:set-active-face', faceId),
        uploadFace: (payload) => ipcRenderer.invoke('avatar:upload-face', payload),
        deleteFace: async (faceId) => {
            await ipcRenderer.invoke('avatar:delete-face', faceId);
        },
    },
    ping: () => 'pong',
    __bridgeReady: true,
    __bridgeVersion: '1.0.0',
};
logPreloadInfo('Preparing to expose renderer bridge.', {
    keys: Object.keys(api),
    hasAvatarBridge: typeof api.avatar !== 'undefined',
});
function exposeBridge() {
    try {
        contextBridge.exposeInMainWorld('aiembodied', api);
        logPreloadInfo('Renderer bridge exposed successfully.', {
            keys: Object.keys(api),
            hasAvatarBridge: typeof api.avatar !== 'undefined',
            bridgeReady: api.__bridgeReady,
            bridgeVersion: api.__bridgeVersion,
        });
        forwardPreloadDiagnostics('info', 'preload:bridge-exposed', {
            keys: Object.keys(api),
            hasAvatarBridge: typeof api.avatar !== 'undefined',
            bridgeReady: api.__bridgeReady,
            bridgeVersion: api.__bridgeVersion,
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logPreloadError('Failed to expose renderer bridge.', { message });
        throw error;
    }
}
// Expose the bridge immediately; preload runs before DOM is ready but
// contextBridge is available and safe to use at this time.
try {
    exposeBridge();
}
catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logPreloadError('Bridge exposure failed at preload init.', { message });
}
