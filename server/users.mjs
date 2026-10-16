// ═══ claude_cloud-ce:身份与隔离 ═══
// user 账户 / web 登录态 / worker 接入密钥。零依赖,crypto 哈希,可选落盘 config/users.json。
//   · web 控制端:username/password 登录 → web token(Bearer)
//   · cc worker:预先为账户签发 worker key → 放进 HTTPS_PROXY 的凭据位 → 代理层据此归属 user
// 两者都解析到同一个 userId;RC session 归属 userId,彼此只见自己的 → cc 与 web 隔离。
import crypto from 'node:crypto';
import fs from 'node:fs';

const DEFAULT_SCOPES = ['user:inference', 'user:profile', 'user:office', 'user:ccr_inference'];

export class Identity {
  constructor(log, opts = {}) {
    this.log = log;
    this.file = opts.file || null;
    this.users = new Map();        // userId → {id,username,salt,hash,scopes,createdAt}
    this.byName = new Map();       // username → userId
    this.webTokens = new Map();    // token → {userId, expiresAt}
    this.workerKeys = new Map();   // key → {userId, label, createdAt}
    this.webTtlMs = opts.webTtlMs ?? 7 * 24 * 3600 * 1000;
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const u of d.users || []) { this.users.set(u.id, u); this.byName.set(u.username, u.id); }
      for (const k of Object.keys(d.workerKeys || {})) this.workerKeys.set(k, d.workerKeys[k]);
      for (const k of Object.keys(d.webTokens || {})) this.webTokens.set(k, d.webTokens[k]);
      this.log(`[id] 载入 ${this.users.size} 用户 / ${this.workerKeys.size} worker key`);
    } catch { }
  }
  _save() {
    if (!this.file) return;
    const d = { users: [...this.users.values()], workerKeys: {}, webTokens: {} };
    for (const [k, v] of this.workerKeys) d.workerKeys[k] = v;
    for (const [k, v] of this.webTokens) d.webTokens[k] = v;
    try { fs.writeFileSync(this.file, JSON.stringify(d, null, 2), { mode: 0o600 }); }
    catch (e) { this.log(`[id] 落盘失败 ${e.message}`); }
  }

  newId(p) { return `${p}_${crypto.randomBytes(9).toString('hex')}`; }

  register(username, password, scopes) {
    if (!username || !password) throw new Error('username/password required');
    if (this.byName.has(username)) throw new Error('username taken');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    const id = this.newId('usr');
    const u = { id, username, salt, hash, scopes: scopes || DEFAULT_SCOPES, createdAt: Date.now() };
    this.users.set(id, u); this.byName.set(username, id); this._save();
    this.log(`[id] 注册 ${username} → ${id}`);
    return u;
  }

  verify(username, password) {
    const id = this.byName.get(username); if (!id) return null;
    const u = this.users.get(id); if (!u) return null;
    const hash = crypto.scryptSync(password, u.salt, 64).toString('hex');
    const a = Buffer.from(hash), b = Buffer.from(u.hash);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return u;
  }

  issueWebToken(userId) {
    const token = this.newId('web');
    this.webTokens.set(token, { userId, expiresAt: Date.now() + this.webTtlMs });
    this._save();
    return token;
  }
  resolveWebToken(token) {
    const t = token && this.webTokens.get(token); if (!t) return null;
    if (Date.now() > t.expiresAt) { this.webTokens.delete(token); return null; }
    return this.users.get(t.userId) || null;
  }
  revokeWebToken(token) { if (this.webTokens.delete(token)) this._save(); }

  createWorkerKey(userId, label) {
    const key = this.newId('wkr');
    this.workerKeys.set(key, { userId, label: label || '', createdAt: Date.now() });
    this._save();
    this.log(`[id] 签发 worker key for ${userId} (${label || ''})`);
    return key;
  }
  resolveWorkerKey(key) { const w = key && this.workerKeys.get(key); return w ? (this.users.get(w.userId) || null) : null; }
  listWorkerKeys(userId) {
    const out = [];
    for (const [k, v] of this.workerKeys) if (v.userId === userId) out.push({ key: k, label: v.label, createdAt: v.createdAt });
    return out;
  }

  publicUser(u) { return u ? { id: u.id, username: u.username, scopes: u.scopes } : null; }
}