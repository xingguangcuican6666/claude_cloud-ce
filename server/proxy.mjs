// ═══ claude_cloud-ce:C 形态入口(远程服务器 + HTTPS_PROXY)═══
//
// 客户端只设两个环境变量即可接入,无需 root、无需改 /etc/hosts:
//   HTTPS_PROXY=http://<本机>:8898
//   NODE_EXTRA_CA_CERTS=<ca.pem>          (服务器用真域名证书时连这个都免了)
//
// 客户端对第一方域名发标准 HTTP CONNECT:
//   CONNECT api.anthropic.com:443   → 我们终结自签 TLS,把明文喂给 core(RC + 推理反代)
//   CONNECT <其它>:443              → 原样透传到真实目标(否则客户端装插件/更新会挂)
//
// ⚠ 这是一个 CONNECT 代理。监听 0.0.0.0 时它对任何能连到本端口的人都是开放跳板。
//   生产务必二选一:① 只绑内网/127.0.0.1 + 客户端走 SSH 隧道;② 防火墙按源 IP 放行。

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createCore } from './core.mjs';
import { loadConfig } from './config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig(ROOT);

if (!cfg.upstreamBase) {
  console.error('[fatal] 未配置 upstreamBase:不知道把推理请求转发到哪个第三方端点。');
  console.error('        设置环境变量 UPSTREAM_BASE=https://你的第三方端点,');
  console.error('        或复制 config/config.example.json 为 config/config.json 并填 upstreamBase 字段。');
  process.exit(1);
}

const LOG = cfg.log || path.join(ROOT, 'proxy.log');

const log = (...a) => {
  const l = a.join(' ');
  try { fs.appendFileSync(LOG, l + '\n'); } catch { }
  if (!cfg.quiet) process.stdout.write(l + '\n');
};
const readBody = (req) => new Promise((res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b));
});

const CERT = fs.readFileSync(path.join(cfg.configDir, 'chain.pem'));
const KEY = fs.readFileSync(path.join(cfg.configDir, 'leaf.key'));

const core = createCore({
  log,
  features: JSON.parse(fs.readFileSync(path.join(ROOT, 'features.json'), 'utf8')),
  upstream: cfg.upstreamBase,
  upstreamToken: cfg.upstreamToken,
  upstreamHeaders: { 'content-type': 'application/json' },
  smtp: cfg.smtp, fcmServiceAccountPath: cfg.fcmServiceAccountPath,
});

// ── 终结后的明文流 → core ────────────────────────────────────────────
// base 传 https://api.anthropic.com:/bridge 响应里的 api_base_url 要让客户端
// 还能经由同一代理解析回来。
const httpSrv = http.createServer((req, res) => {
  const url = new URL(req.url, 'https://api.anthropic.com');
  core.handle(req, res, url, 'https://api.anthropic.com').catch((e) => {
    log(`[err] ${req.method} ${url.pathname} ${e.stack || e.message}`);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(e.message) }));
  });
});
// SSE 下行是长连接:关掉所有会把它掐断的超时(Node v18+ requestTimeout 默认 5min,
// keepAliveTimeout 5s)。否则会话挂一会儿就 "operation was aborted"。
httpSrv.keepAliveTimeout = 0;
httpSrv.headersTimeout = 0;
httpSrv.requestTimeout = 0;
httpSrv.timeout = 0;
const tlsSrv = tls.createServer({ cert: CERT, key: KEY, minVersion: 'TLSv1.2' });
tlsSrv.on('tlsClientError', (e) => log(`[tls] ${e.message}`));
tlsSrv.on('secureConnection', (s) => { s.on('error', () => { }); httpSrv.emit('connection', s); });

// ── CONNECT 代理:按 host 分流 ─────────────────────────────────────────
const proxy = http.createServer((req, res) => {
  // 普通(非 CONNECT)请求:代理一般不会收到,给个明确提示
  res.writeHead(405, { 'content-type': 'text/plain' });
  res.end('this is a CONNECT proxy\n');
});
proxy.on('connect', (req, clientSock, head) => {
  const [host, portStr] = req.url.split(':');
  const port = Number(portStr) || 443;
  clientSock.on('error', () => { });
  clientSock.setTimeout(0);        // CONNECT 之后是长连接,别让它空闲超时
  clientSock.setNoDelay(true);
  if (host === 'api.anthropic.com') {
    log(`[proxy] CONNECT ${req.url} → 终结(core)`);
    clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) clientSock.unshift(head);
    tlsSrv.emit('connection', clientSock);
  } else {
    // 透传:直连真实目标,双向 pipe
    const up = net.connect(port, host, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) up.write(head);
      clientSock.pipe(up); up.pipe(clientSock);
    });
    up.on('error', (e) => { log(`[passthru] ${host}:${port} ${e.message}`); clientSock.destroy(); });
  }
});
proxy.listen(cfg.proxyPort, cfg.bind, () => {
  log(`[boot] CONNECT 代理 http://${cfg.bind}:${cfg.proxyPort}`);
  log(`[boot] 推理上游 ${cfg.upstreamBase}`);
  log(`[boot] 第三方凭据 ${cfg.upstreamToken ? '已加载' : '缺失 — 推理会 401'}`);
  if (cfg.bind === '0.0.0.0') log('[warn] 代理监听 0.0.0.0:这是开放跳板,请配合 SSH 隧道或防火墙限制来源');
});

// ── 控制面("手机端" API,默认只回环)────────────────────────────────
const RC = core.RC;
const control = async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  const p = u.pathname;
  const json = (o, code = 200) => {
    const b = JSON.stringify(o);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b) });
    res.end(b);
  };
  if (p === '/sessions') {
    const out = [];
    for (const s of RC.sessions.values()) out.push({
      id: s.id, title: s.title, state: s.state, epoch: s.epoch,
      events: s.events.length, subscribers: s.subscribers.size,
      createdAt: new Date(s.createdAt).toISOString(), lastSeenAt: new Date(s.lastSeenAt).toISOString(),
    });
    return json(out);
  }
  const m = p.match(/^\/sessions\/([^/]+)\/(events|prompt|request)$/);
  if (m) {
    const s = RC.get(m[1]);
    if (!s) return json({ error: 'no such session' }, 404);
    if (m[2] === 'events') {
      const after = Number(u.searchParams.get('after') ?? 0);
      return json(s.events.filter((_, i) => i >= after));
    }
    if (m[2] === 'prompt') {
      const text = (JSON.parse((await readBody(req)) || '{}').text) ?? '';
      if (!text) return json({ error: 'text required' }, 400);
      RC.push(s, {
        type: 'user', uuid: `u_${crypto.randomBytes(12).toString('hex')}`,
        session_id: s.id, parent_tool_use_id: null,
        message: { role: 'user', content: text },
      });
      log(`[ctl] ${s.id} 注入用户消息(${text.length}B)`);
      return json({ ok: true, delivered: s.subscribers.size });
    }
    const b = JSON.parse((await readBody(req)) || '{}');
    return json(await RC.request(s, b.subtype || 'initialize', b.payload || {}, b.timeout_ms || 120000));
  }
  return json({ error: 'unknown control path', path: p }, 404);
};
http.createServer((req, res) => control(req, res).catch((e) => {
  log(`[ctl:err] ${e.stack || e.message}`);
  if (!res.headersSent) res.writeHead(500);
  res.end(JSON.stringify({ error: String(e.message) }));
})).listen(cfg.ctlPort, cfg.ctlBind, () => log(`[boot] 控制面 http://${cfg.ctlBind}:${cfg.ctlPort}`));

process.on('uncaughtException', (e) => log(`[uncaught] ${e.stack || e.message}`));
process.on('SIGTERM', () => { log('[boot] SIGTERM'); process.exit(0); });