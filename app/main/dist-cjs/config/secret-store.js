"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InMemorySecretStore = void 0;
class InMemorySecretStore {
    constructor() {
        this.store = new Map();
    }
    async getSecret(key) {
        return this.store.get(key) ?? null;
    }
    async setSecret(key, value) {
        this.store.set(key, value);
    }
    async deleteSecret(key) {
        this.store.delete(key);
    }
}
exports.InMemorySecretStore = InMemorySecretStore;
