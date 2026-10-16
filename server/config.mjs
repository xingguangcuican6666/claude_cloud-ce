// ═══ claude_cloud-ce:统一配置加载(零依赖,不引入 ajv/zod 等校验库)═══
//
// 优先级(沿用项目里早就存在的 thirdPartyToken()/adminSecret() 写法,这里只是把散落在
// app.mjs/proxy.mjs 两处的重复样板代码收编成一个模块,不是发明新规则):
//   环境变量 > config/config.json > 独立 token 文件(upstream.token/admin.token/smtp.json,
//   向后兼容旧的手动配置方式) > 内置默认值
//
// 所有现有环境变量名一个不改、一个不删——已经在跑的部署升级代码后原样能用,不强制迁移。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const normBearer = (t) => (!t ? null : (t.startsWith('Bearer ') || t.startsWith('sk-') ? t : `Bearer ${t}`));
const readTokenFile = (dir, name) => {
  try { const t = fs.readFileSync(path.join(dir, name), 'utf8').trim(); return t || null; }
  catch { return null; }
};

export function loadConfig(root) {
  const configDir = process.env.CC_CONFIG || path.join(root, 'config');
  let fileCfg = {};
  try { fileCfg = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf8')); } catch { /* 没有 config.json 就全靠 env/旧文件/默认值 */ }

  const str = (envKey, fileKey, fallback) => process.env[envKey] ?? fileCfg[fileKey] ?? fallback;
  const num = (envKey, fileKey, fallback) => Number(str(envKey, fileKey, fallback));

  let smtp = fileCfg.smtp || null;
  if (!smtp) { try { smtp = JSON.parse(fs.readFileSync(path.join(configDir, 'smtp.json'), 'utf8')); } catch { /* 邮件功能可选,没配就是 null */ } }

  return {
    configDir,
    bind: str('CC_BIND', 'bind', '0.0.0.0'),
    proxyPort: num('CC_PROXY_PORT', 'proxyPort', 8898),
    webPort: num('CC_WEB_PORT', 'webPort', 8890),
    appPort: num('CC_APP_PORT', 'appPort', 443),
    ctlBind: str('CC_CTL_BIND', 'ctlBind', '127.0.0.1'),
    ctlPort: num('CC_CTL_PORT', 'ctlPort', 9999),
    // 核心反代目标,没有"合理默认值"这回事——留空由调用方(app.mjs/proxy.mjs)决定 fail-fast,
    // 不能像作者本机那样写死真实域名(否则陌生部署者会悄悄把流量转发到作者的服务器)。
    upstreamBase: process.env.UPSTREAM_BASE || fileCfg.upstreamBase || null,
    upstreamToken: normBearer(process.env.CC_UPSTREAM_TOKEN || fileCfg.upstreamToken || readTokenFile(configDir, 'upstream.token')),
    adminSecret: process.env.CC_ADMIN_SECRET || fileCfg.adminSecret || readTokenFile(configDir, 'admin.token'),
    fcmServiceAccountPath: str('CC_FCM_SA', 'fcmServiceAccountPath', null),
    smtp,
    log: str('CC_LOG', 'log', null),
    quiet: !!(process.env.CC_QUIET ?? fileCfg.quiet ?? false),
  };
}

// admin secret 没有"正确答案"——它是一个纯随机的管理员口令,用户自己想不出比
// crypto.randomBytes 更好的值。未配置时自动生成一份、持久化到 config/admin.token(0600),
// 和此前手动 `openssl rand -hex 24 > config/admin.token` 的效果一致,只是自动化、
// 且只会在"从没配置过"时发生一次(此后文件里有值,直接读回,不会每次启动都换一把)。
export function ensureAdminSecret(cfg, log) {
  if (cfg.adminSecret) return cfg.adminSecret;
  const secret = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(cfg.configDir, { recursive: true });
    fs.writeFileSync(path.join(cfg.configDir, 'admin.token'), secret, { mode: 0o600 });
    log(`[config] 首次启动,已自动生成 admin secret 并写入 ${path.join(cfg.configDir, 'admin.token')}(用它作 Authorization: Bearer 调用 /admin/accounts*)`);
  } catch (e) {
    log(`[config] admin secret 生成后写盘失败,本次进程仍可用,但重启会换一把:${e.message}`);
  }
  cfg.adminSecret = secret;
  return secret;
}
