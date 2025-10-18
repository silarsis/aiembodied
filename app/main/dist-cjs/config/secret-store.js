"use strict";
export class InMemorySecretStore {
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
