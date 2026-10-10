import { writeFile, mkdir, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';

const HEX64 = /^[a-f0-9]{64}$/;
const UUID36 = /^[a-f0-9-]{36}$/i;
const PIN8 = /^[0-9]{8}$/;

export class Store {
  constructor(file, ttl) { this.file = file; this.ttl = ttl; this.db = { pins: {}, cooldowns: {} }; }
  async load() {
    try {
      const raw = await readFile(this.file, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object' && data.pins && typeof data.pins === 'object') this.db = { pins: data.pins, cooldowns: (data.cooldowns && typeof data.cooldowns === 'object') ? data.cooldowns : {} };
    } catch { /* começa vazio */ }
  }
  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    await writeFile(tmp, JSON.stringify(this.db), 'utf8');
    await rename(tmp, this.file);
  }
  sweep() {
    const now = Date.now();
    for (const [pin, row] of Object.entries(this.db.pins)) {
      if (row.expiresAt <= now && !row.result) delete this.db.pins[pin];
    }
  }
  activeOf(ownerId) {
    const now = Date.now();
    return Object.entries(this.db.pins).filter(([, r]) => r.ownerId === ownerId && !r.used && r.expiresAt > now);
  }
  async create(ownerId, targetId) {
    this.sweep();
    const last = this.db.cooldowns[ownerId] ?? 0;
    const wait = 15000 - (Date.now() - last);
    if (wait > 0) throw new Error(`Aguarde ${Math.ceil(wait / 1000)}s para gerar outro PIN.`);
    if (this.activeOf(ownerId).length >= 5) throw new Error('Você já tem 5 PINs ativos. Aguarde expirar ou usar.');
    let pin;
    do { pin = String(randomInt(0, 100_000_000)).padStart(8, '0'); } while (this.db.pins[pin]);
    const now = Date.now();
    const row = { pin, ownerId, targetId, createdAt: now, expiresAt: now + this.ttl, used: false, token: null, clientId: null, result: null, delivered: false, messageIds: [] };
    this.db.pins[pin] = row; this.db.cooldowns[ownerId] = Date.now();
    await this.save();
    return row;
  }
  async claim(pin, clientId) {
    if (!PIN8.test(pin) || typeof clientId !== 'string' || !UUID36.test(clientId)) return null;
    this.sweep();
    const row = this.db.pins[pin];
    if (!row || row.used || row.expiresAt <= Date.now()) return null;
    row.used = true;
    row.clientId = clientId;
    row.token = randomBytes(32).toString('hex');
    await this.save();
    return { token: row.token };
  }
  async submit(token, payload) {
    if (typeof token !== 'string' || !HEX64.test(token)) return null;
    const row = Object.values(this.db.pins).find((r) => r.token === token);
    if (!row || !row.used) return null;
    row.result = { ...payload, receivedAt: Date.now() };
    row.delivered = false;
    row.messageIds = [];
    await this.save();
    return row;
  }
  async get(pin) {
    this.sweep();
    return this.db.pins[pin] ?? null;
  }
  async getPanel() { return this.db.panel ?? null; }
  async setPanel(channelId, messageId) { this.db.panel = { channelId, messageId }; await this.save(); }
  async pending() {
    return Object.values(this.db.pins).filter((r) => r.result && !r.delivered);
  }
  async delivered(pin, messageIds) {
    const row = this.db.pins[pin];
    if (!row) return;
    row.delivered = true;
    row.messageIds = messageIds;
    await this.save();
  }
}
