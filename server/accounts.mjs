// ═══ claude_cloud-ce:官方 App 消费侧多账号 ═══
// 与 users.mjs 的 Identity 完全独立——那套服务 Web 控制台/cc worker(username/password);
// 这套服务官方 Android App 消费侧 API(email+验证码登录,account/organization 契约形状)。
//
// 每个账号拥有专属 org_uuid。App 登录后把它记在响应的 account.memberships[0].organization.uuid 里,
// 后续所有 /api/organizations/{org}/... 请求会原样带回这个值——这就是请求级身份信道,
// 不需要新增 Cookie/Header 校验机制,core.mjs 按 org_uuid 反查回账号即可。
import crypto from 'node:crypto';
import fs from 'node:fs';

export const DEFAULT_SEED_ACCOUNT = {
  uuid: 'usr_cccloud00000000000001', org_uuid: '20937a9c-05e5-4f77-ac5e-dfd4dbbacc1e',
  email: 'cc@cloud.local', full_name: 'cc-cloud', display_name: 'cc-cloud',
  is_verified: true, banned: false, banned_at: null, banned_reason: null,
  created_at: '2024-01-01T00:00:00.000Z', updated_at: '2024-01-01T00:00:00.000Z', settings: {},
};

export class AccountStore {
  constructor(log, { file, seed = DEFAULT_SEED_ACCOUNT } = {}) {
    this.log = log || (() => {});
    this.file = file || null;
    this.byUuid = new Map();   // uuid -> account
    this.byEmail = new Map();  // email(小写) -> uuid
    this.byOrg = new Map();    // org_uuid -> uuid
    this._load();
    this._ensureSeed(seed);
  }

  _index(a) {
    this.byUuid.set(a.uuid, a);
    this.byEmail.set(a.email, a.uuid);
    this.byOrg.set(a.org_uuid, a.uuid);
  }

  _load() {
    if (!this.file) return;
    try {
      const d = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const a of d.accounts || []) this._index(a);
      this.log(`[acct] 载入 ${this.byUuid.size} 个账号`);
    } catch { /* 首次无文件 */ }
  }
  _save() {
    if (!this.file) return;
    const d = { accounts: [...this.byUuid.values()] };
    try { fs.writeFileSync(this.file, JSON.stringify(d, null, 2), { mode: 0o600 }); }
    catch (e) { this.log(`[acct] 落盘失败 ${e.message}`); }
  }
  // 种子账号的 uuid/org_uuid 固定沿用历史写死值:已经登录过的 App 客户端升级后无需重新登录。
  _ensureSeed(seed) {
    if (!seed || this.byUuid.has(seed.uuid)) return;
    this._index({ ...seed });
    this._save();
    this.log(`[acct] 写入种子账号 ${seed.uuid}`);
  }

  findByEmail(email) {
    const uuid = email && this.byEmail.get(String(email).toLowerCase());
    return uuid ? this.byUuid.get(uuid) || null : null;
  }
  findByOrgUuid(orgUuid) {
    const uuid = orgUuid && this.byOrg.get(orgUuid);
    return uuid ? this.byUuid.get(uuid) || null : null;
  }
  findByUuid(uuid) { return (uuid && this.byUuid.get(uuid)) || null; }
  // admin 端点用:ref 可以是 uuid 也可以是 email,不用记两套标识符
  resolveRef(ref) {
    if (!ref) return null;
    return this.findByUuid(ref) || this.findByEmail(ref);
  }

  // 幂等 find-or-create:email 已存在则直接返回(created:false),否则新建账号 + 专属组织
  create({ email, full_name, display_name } = {}) {
    const norm = String(email || '').trim().toLowerCase();
    if (!norm) throw new Error('email required');
    const existing = this.findByEmail(norm);
    if (existing) return { account: existing, created: false };
    const now = new Date().toISOString();
    const localPart = norm.split('@')[0] || norm;
    const account = {
      uuid: 'usr_' + crypto.randomBytes(9).toString('hex'),
      org_uuid: crypto.randomUUID(),
      email: norm,
      full_name: full_name || localPart,
      display_name: display_name || full_name || localPart,
      is_verified: true,
      banned: false, banned_at: null, banned_reason: null,
      created_at: now, updated_at: now, settings: {},
    };
    this._index(account); this._save();
    this.log(`[acct] 创建账号 ${account.uuid} email=${norm} org=${account.org_uuid}`);
    return { account, created: true };
  }

  ban(ref, reason) {
    const a = this.resolveRef(ref); if (!a) return null;
    a.banned = true; a.banned_at = new Date().toISOString(); a.banned_reason = reason || null;
    a.updated_at = a.banned_at;
    this._save();
    this.log(`[acct] 封禁 ${a.uuid} email=${a.email} reason=${reason || '(无)'}`);
    return a;
  }
  unban(ref) {
    const a = this.resolveRef(ref); if (!a) return null;
    a.banned = false; a.banned_at = null; a.banned_reason = null;
    a.updated_at = new Date().toISOString();
    this._save();
    this.log(`[acct] 解封 ${a.uuid} email=${a.email}`);
    return a;
  }
  list({ banned } = {}) {
    const all = [...this.byUuid.values()];
    return typeof banned === 'boolean' ? all.filter((a) => !!a.banned === banned) : all;
  }
}
