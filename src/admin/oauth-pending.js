import { generatePkce } from "../providers/antigravity/oauth.js";

export class PendingLogins {
  constructor({ ttlMs = 10 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.items = new Map();
  }

  create({ redirectUri, closer = null }) {
    const { verifier, challenge } = generatePkce();
    const state = generatePkce().verifier;
    const rec = {
      state,
      verifier,
      challenge,
      redirectUri,
      closer,
      createdAt: Date.now(),
      done: false,
      error: null,
      account: null,
    };
    this.items.set(state, rec);
    return rec;
  }

  get(state) {
    const rec = this.items.get(state);
    if (!rec) return null;
    if (Date.now() - rec.createdAt > this.ttlMs) {
      this.items.delete(state);
      return null;
    }
    return rec;
  }

  finish(state, { error = null, account = null } = {}) {
    const rec = this.items.get(state);
    if (!rec) return null;
    rec.done = true;
    rec.error = error;
    rec.account = account;
    return rec;
  }

  take(state) {
    const rec = this.get(state);
    if (rec?.done) this.items.delete(state);
    return rec;
  }
}
