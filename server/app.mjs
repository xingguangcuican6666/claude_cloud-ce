// ═══ claude_cloud-ce:完整服务器(OAuth/login + cc↔web 隔离 + Web 端)═══
//
// 和官方一样的形态:一台服务器,既是 RC 会话服务,又是 web 控制台,还自建身份。
//   · cc worker:HTTPS_PROXY=http://<worker-key>@server:8898
//       代理读 Proxy-Authorization → resolveWorkerKey → user,打在 TLS 连接上(_ccUser)
//       → core 建会话时归属该 user,之后跨 user 的操作一律 404
//   · 浏览器:连 web 端口(默认 8890),username/password 登录拿 web token
//       → 只看得到/控制得了自己 user 的会话
//
// 三个监听口:
//   CC_PROXY_PORT 8898  CONNECT 代理(worker 走这;api.anthropic.com 终结,其余透传)
//   CC_WEB_PORT   8890  Web 控制台 + 身份 API + 会话 SSE(浏览器走这)
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCore } from './core.mjs';
import { Identity } from './users.mjs';
import { AccountStore } from './accounts.mjs';
import { loadConfig, ensureAdminSecret } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);

// 核心反代目标没有"合理默认值"——留空就悄悄把流量转发到作者本机的上游,这对陌生部署者
// 是比直接崩溃更糟的后果(流量方向错得不明显),所以这里启动即校验、清晰报错退出。
if (!cfg.upstreamBase) {
  console.error('[fatal] 未配置 upstreamBase:不知道把推理请求转发到哪个第三方端点。');
  console.error('        设置环境变量 UPSTREAM_BASE=https://你的第三方端点,');
  console.error('        或复制 config/config.example.json 为 config/config.json 并填 upstreamBase 字段。');
  process.exit(1);
}

const WEB_DIR = path.join(ROOT, 'web');
const LOG = cfg.log || path.join(ROOT, 'app.log');

const log = (...a) => {
  const l = a.join(' ');
  try { fs.appendFileSync(LOG, l + '\n'); } catch { }
  if (!cfg.quiet) process.stdout.write(l + '\n');
};
const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });

ensureAdminSecret(cfg, log); // 没配就自动生成一把随机密钥、持久化、打一行日志
function isAdmin(req) {
  if (!cfg.adminSecret) return false;
  const a = req.headers.authorization || '';
  const got = a.startsWith('Bearer ') ? a.slice(7) : '';
  if (!got) return false;
  const A = Buffer.from(got), B = Buffer.from(cfg.adminSecret);
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

const CERT = fs.readFileSync(path.join(cfg.configDir, 'chain.pem'));
const KEY = fs.readFileSync(path.join(cfg.configDir, 'leaf.key'));
const ID = new Identity(log, { file: path.join(cfg.configDir, 'users.json') });
const ACCOUNTS = new AccountStore(log, { file: path.join(cfg.configDir, 'accounts.json') });
const core = createCore({
  log, features: JSON.parse(fs.readFileSync(path.join(ROOT, 'features.json'), 'utf8')),
  upstream: cfg.upstreamBase, upstreamToken: cfg.upstreamToken, upstreamHeaders: { 'content-type': 'application/json' },
  accounts: ACCOUNTS, smtp: cfg.smtp, fcmServiceAccountPath: cfg.fcmServiceAccountPath,
});
const RC = core.RC;

// ── worker 身份:Proxy-Authorization 的凭据位 user 段 = worker-key → user ──
function workerUserFromPA(req) {
  const h = req.headers['proxy-authorization'] || '';
  const m = h.match(/^Basic\s+(.+)$/i);
  if (!m) return null;
  let decoded = '';
  try { decoded = Buffer.from(m[1], 'base64').toString('utf8'); } catch { return null; }
  return ID.resolveWorkerKey(decoded.split(':')[0]);
}

// 终结后的明文流 → core,带上这条连接的 worker user(req.socket._ccUser)
// 遥测/崩溃上报域:就地吞掉,数据绝不出我们的服务
const TELEMETRY = /(^|\.)(sentry\.io|segment\.(io|com)|datadoghq\.com|crashlytics\.com|mixpanel\.com|amplitude\.com)$|googleapis\.com$|firebaseio\.com$/i;
const httpSrv = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  if (TELEMETRY.test(host)) {
    log(`[app] 截断遥测 ${host} ${req.method} ${req.url.slice(0, 48)}`);
    res.writeHead(204); return res.end();
  }
  const origin = `https://${host || 'api.anthropic.com'}`;
  const url = new URL(req.url, origin);
  core.handle(req, res, url, origin, { workerUserId: req.socket._ccUser || null })
    .catch((e) => { log(`[err] ${req.method} ${url.pathname} ${e.message}`); if (!res.headersSent) res.writeHead(500); res.end('{}'); });
});
httpSrv.keepAliveTimeout = 0; httpSrv.headersTimeout = 0; httpSrv.requestTimeout = 0; httpSrv.timeout = 0;

// ── CONNECT 代理:api.anthropic.com 终结 + worker 鉴权;其余透传 ──
const proxy = http.createServer((q, s) => { s.writeHead(405); s.end('CONNECT only\n'); });
proxy.on('connect', (req, clientSock, head) => {
  const [host, portStr] = req.url.split(':');
  const port = Number(portStr) || 443;
  clientSock.on('error', () => { });
  clientSock.setTimeout(0); clientSock.setNoDelay(true);
  if (host === 'api.anthropic.com') {
    const user = workerUserFromPA(req);
    if (!user) {
      log('[proxy] 拒绝未授权 worker(无有效 worker-key)');
      clientSock.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="cc-worker"\r\n\r\n');
      return clientSock.destroy();
    }
    clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const t = new tls.TLSSocket(clientSock, { isServer: true, cert: CERT, key: KEY, minVersion: 'TLSv1.2' });
    t._ccUser = user.id;
    t.on('error', (e) => log(`[tls:conn] ${e.message}`));
    if (head && head.length) clientSock.unshift(head);
    httpSrv.emit('connection', t);
  } else {
    const up = net.connect(port, host, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      clientSock.pipe(up); up.pipe(clientSock);
    });
    up.on('error', () => clientSock.destroy());
  }
});
proxy.listen(cfg.proxyPort, cfg.bind, () => {
  log(`[boot] CONNECT 代理 :${cfg.proxyPort}  上游 ${cfg.upstreamBase}  凭据 ${cfg.upstreamToken ? '有' : '缺'}`);
  if (cfg.bind === '0.0.0.0') log('[warn] 代理绑 0.0.0.0;worker 有 key 鉴权,仍建议防火墙/SSH 收口');
});

// ── App 直连 TLS 端点:手机 App 不走 HTTPS_PROXY,它直接 TLS 连本服务器 ──
//    (apk 把 host 改成本机 IP,或 root 设备 hosts 把 api.anthropic.com 指过来——都终结在这)
//    终结 TLS → 同一个 httpSrv(core)。App 侧身份暂为空(workerUserId=null → 默认 user)。
const APP_PORT = cfg.appPort;
if (APP_PORT > 0) {
  const appTls = tls.createServer({ cert: CERT, key: KEY, minVersion: 'TLSv1.2' }, (sock) => {
    sock.setNoDelay(true); sock.setTimeout(0);
    log(`[app] TLS 连入 ${sock.remoteAddress} SNI=${sock.servername || '-'}`);
    httpSrv.emit('connection', sock);
  });
  appTls.on('tlsClientError', (e) => log(`[app:tls] ${e.message}`));
  appTls.on('error', (e) => log(`[app] 端点错误 ${e.message}(443 需特权:root 跑或 setcap node)`));
  appTls.listen(APP_PORT, cfg.bind, () => log(`[boot] App 直连 TLS :${APP_PORT}`));
}

// ── Web 控制台 + 身份 API + 会话 SSE(浏览器连这个口)──
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function serveStatic(res, rel) {
  const fp = path.join(WEB_DIR, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));
  if (!fp.startsWith(WEB_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  });
}
const webUser = (req) => { const a = req.headers.authorization || ''; return a.startsWith('Bearer ') ? ID.resolveWebToken(a.slice(7)) : null; };

async function web(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const json = (o, c = 200) => { const b = JSON.stringify(o); res.writeHead(c, { 'content-type': 'application/json' }); res.end(b); };

  if (p === '/auth/register' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req)) || '{}');
    try { const user = ID.register(b.username, b.password); return json({ token: ID.issueWebToken(user.id), user: ID.publicUser(user) }); }
    catch (e) { return json({ error: e.message }, 400); }
  }
  if (p === '/auth/login' && req.method === 'POST') {
    const b = JSON.parse((await readBody(req)) || '{}');
    const user = ID.verify(b.username, b.password);
    if (!user) return json({ error: 'invalid credentials' }, 401);
    return json({ token: ID.issueWebToken(user.id), user: ID.publicUser(user) });
  }

  // ── Admin:官方 App 账号的封禁/unban,curl 直接控制。独立于 web 用户登录态,
  //    用共享密钥鉴权(CC_ADMIN_SECRET/config/admin.token,见 isAdmin),未配置则 fail-closed。 ──
  if (p.startsWith('/admin/accounts')) {
    if (!isAdmin(req)) return json({ error: 'unauthorized' }, 401);
    if (p === '/admin/accounts' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)) || '{}');
      try { return json(ACCOUNTS.create({ email: b.email, full_name: b.full_name, display_name: b.display_name })); }
      catch (e) { return json({ error: e.message }, 400); }
    }
    if (p === '/admin/accounts' && req.method === 'GET') {
      const bp = u.searchParams.get('banned');
      return json({ accounts: ACCOUNTS.list(bp === null ? {} : { banned: bp === 'true' }) });
    }
    const am = p.match(/^\/admin\/accounts\/([^/]+)(?:\/(ban|unban))?$/);
    if (am) {
      const ref = decodeURIComponent(am[1]);
      if (!am[2] && req.method === 'GET') {
        const a = ACCOUNTS.resolveRef(ref);
        return a ? json({ account: a }) : json({ error: 'not found' }, 404);
      }
      if (am[2] === 'ban' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        const a = ACCOUNTS.ban(ref, b.reason);
        return a ? json({ account: a }) : json({ error: 'not found' }, 404);
      }
      if (am[2] === 'unban' && req.method === 'POST') {
        const a = ACCOUNTS.unban(ref);
        return a ? json({ account: a }) : json({ error: 'not found' }, 404);
      }
    }
    return json({ error: 'not found', path: p }, 404);
  }

  // ── 以下需登录 ──
  const me = webUser(req);
  if (p === '/auth/me') return me ? json({ user: ID.publicUser(me) }) : json({ error: 'unauthorized' }, 401);
  if (p === '/auth/logout' && req.method === 'POST') { const a = req.headers.authorization || ''; if (a.startsWith('Bearer ')) ID.revokeWebToken(a.slice(7)); return json({ ok: true }); }

  if (p === '/api/worker-keys') {
    if (!me) return json({ error: 'unauthorized' }, 401);
    if (req.method === 'GET') return json({ keys: ID.listWorkerKeys(me.id) });
    if (req.method === 'POST') { const b = JSON.parse((await readBody(req)) || '{}'); return json({ key: ID.createWorkerKey(me.id, b.label) }); }
  }

  if (p === '/api/sessions' && req.method === 'GET') {
    if (!me) return json({ error: 'unauthorized' }, 401);
    const out = [];
    for (const s of RC.sessions.values()) if (s.userId === me.id)
      out.push({ id: s.id, title: s.title, state: s.state, events: s.events.length, lastSeenAt: new Date(s.lastSeenAt).toISOString() });
    return json({ sessions: out });
  }

  const m = p.match(/^\/api\/sessions\/([^/]+)\/(events|stream|prompt|request)$/);
  if (m) {
    if (!me) return json({ error: 'unauthorized' }, 401);
    const s = RC.get(m[1]);
    if (!s || s.userId !== me.id) return json({ error: 'no such session' }, 404);
    if (m[2] === 'stream') return RC.subscribeWeb(s, req, res, Number(u.searchParams.get('after') || 0));
    if (m[2] === 'events') return json({ events: s.events.slice(Number(u.searchParams.get('after') || 0)) });
    if (m[2] === 'prompt') {
      const text = (JSON.parse((await readBody(req)) || '{}').text) ?? '';
      if (!text) return json({ error: 'text required' }, 400);
      RC.push(s, { type: 'user', uuid: `u_${crypto.randomBytes(12).toString('hex')}`, session_id: s.id, parent_tool_use_id: null, message: { role: 'user', content: text } });
      log(`[web] ${s.id} 注入消息(${text.length}B, user=${me.id})`);
      return json({ ok: true, delivered: s.subscribers.size });
    }
    if (m[2] === 'request') {
      const b = JSON.parse((await readBody(req)) || '{}');
      return json(await RC.request(s, b.subtype || 'initialize', b.payload || {}, b.timeout_ms || 120000));
    }
  }

  if (req.method === 'GET') return serveStatic(res, p);
  return json({ error: 'not found', path: p }, 404);
}

const webSrv = http.createServer((req, res) => web(req, res).catch((e) => {
  log(`[web:err] ${e.stack || e.message}`);
  if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: String(e.message) }));
}));
webSrv.keepAliveTimeout = 0; webSrv.requestTimeout = 0;   // 会话 SSE 是长连接
webSrv.listen(cfg.webPort, cfg.bind, () => log(`[boot] Web 控制台 http://${cfg.bind}:${cfg.webPort}`));

process.on('uncaughtException', (e) => log(`[uncaught] ${e.stack || e.message}`));
process.on('SIGTERM', () => { log('[boot] SIGTERM'); process.exit(0); });