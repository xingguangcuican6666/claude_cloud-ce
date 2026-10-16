// ═══ cc-cloud:Remote Control v2 会话服务(纯 HTTP + SSE,零依赖)═══
//
// 逆向结论(v2.1.292):RC v2 **不走 WebSocket**。`bridge.claudeusercontent.com` 那条
// WS 是 "Claude in Chrome" 扩展的桥接(`${url}/chrome/${userId}` → `{type:"connect"}`
// → 服务端回 `{type:"paired"|"waiting"}`),与 Remote Control 无关。
// RC v2 的传输全部落在 api.anthropic.com 的 HTTP 端点上:
//
//   POST /v1/code/sessions                       → {session:{id:"cse_*"}}
//   POST /v1/code/sessions/{id}/bridge           → {worker_jwt, api_base_url,
//                                                   expires_in, worker_epoch}
//   GET  {api}/v1/code/sessions/{id}/worker/events/stream   ← SSE 下行
//   PUT  {api}/v1/code/sessions/{id}/worker              → 上报状态
//   POST {api}/v1/code/sessions/{id}/worker/events         → 上行事件
//   POST {api}/v1/code/sessions/{id}/worker/heartbeat
//
// 鉴权:`Authorization: Bearer <oauth>` + `X-Trusted-Device-Token`(可选)。
// `worker_jwt` 的作用域就是这条 session 路径 —— 我们自己签,校验逻辑在我们手里。
//
// 帧格式(上下行同构):
//   {type:"user"|"assistant"|"system"|"control_response"|…,
//    uuid, session_id, …}
// 服务端 → 客户端的请求是 `{type:"control_request", request_id, request:{subtype}}`,
// 客户端必须回 `{type:"control_response", request:{subtype, …}, session_id}`。
//
// epoch 语义:每次 worker 注册由服务端分配 `worker_epoch`;带 `{expected_epoch}` 的请求
// 若 epoch 落后 → 409 + `error.expected_epoch/actual_epoch`。我们保持单调递增即可。

import crypto from 'node:crypto';

const EPOCH_START = 1;

export class SessionStore {
  constructor(log, opts = {}) {
    this.log = log;
    this.sessions = new Map();   // sessionId → session
    this.byUser = new Map();     // userId → Set<sessionId>
    this.seq = EPOCH_START;
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    // 每进程随机生成,不持久化——sessions 全在内存,进程重启本来就清空,
    // 不需要跨重启保持同一把密钥(历史上这里曾是写死的 'cc-cloud-local',
    // 所有部署实例共享同一把签名密钥,是个该修的反模式)
    this.jwtSecret = opts.jwtSecret || crypto.randomBytes(32).toString('hex');
  }

  newId() { return `cse_${crypto.randomBytes(24).toString('hex')}`; }
  newJwt(sessionId, epoch) {
    // 自签 JWT:我们既是签发方也是校验方,hs256 足够(与官方无共享密钥)
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const head = b64({ alg: 'HS256', typ: 'JWT' });
    const body = b64({ sub: sessionId, epoch, iss: 'cc-cloud', iat: Math.floor(Date.now() / 1000) });
    const sig = crypto.createHmac('sha256', this.jwtSecret)
      .update(`${head}.${body}`).digest('base64url');
    return `${head}.${body}.${sig}`;
  }

  create({ userId, title, cwd, model, tags, deviceToken }) {
    const id = this.newId();
    const epoch = this.seq++;
    const s = {
      id, userId, title: title || 'cc-cloud session', cwd: cwd || process.cwd(),
      model, tags: tags || [], epoch,
      jwt: this.newJwt(id, epoch),
      expiresAt: Date.now() + this.ttlMs,
      state: 'idle',
      events: [],           // 上行事件(客户端 → 服务端)
      seq: EPOCH_START,     // 下行帧序号(SSE 的 id / sequence_num)
      pending: [],          // 下行请求队列(服务端 → 客户端)
      subscribers: new Set(),// SSE 连接(worker 下行)
      webSubs: new Set(),   // web 控制端的 SSE 连接(上行事件实时转发)
      deviceToken: deviceToken || null,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      delivery: new Map(),  // uuid → delivery 状态
    };
    this.sessions.set(id, s);
    if (!this.byUser.has(userId)) this.byUser.set(userId, new Set());
    this.byUser.get(userId).add(id);
    this.log(`[rc] create ${id} epoch=${epoch} user=${userId}`);
    return s;
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) return null;
    if (Date.now() > s.expiresAt) { this.drop(id, 'expired'); return null; }
    return s;
  }

  drop(id, why) {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const res of s.subscribers) { try { res.end(); } catch { } }
    this.sessions.delete(id);
    this.byUser.get(s.userId)?.delete(id);
    this.log(`[rc] drop ${id} (${why})`);
  }

  // ── 上行:客户端 POST /worker/events ────────────────────────────────
  ingest(s, envelopes) {
    const seqs = [];
    for (const env of envelopes || []) {
      // 客户端上行同样是信封形状:{payload:{type, …}}。request_id 落在
      // payload.response.request_id(或 payload.request.request_id)。
      const ev = env?.payload ?? env;
      const reqId = ev?.response?.request_id ?? ev?.request?.request_id;
      if (ev?.type === 'control_response' && typeof reqId === 'string') {
        const answered = this.respond(s, reqId, ev.response ?? ev.request ?? {});
        if (!answered) this.log(`[rc] ${s.id} ← control_response ${reqId} 无匹配请求(丢弃)`);
        continue;
      }
      const uuid = ev?.uuid;
      if (uuid && s.delivery.has(uuid)) { seqs.push(s.delivery.get(uuid)); continue; }
      const stored = { ...ev, receivedAt: Date.now() };
      s.events.push(stored);
      this._fanoutWeb(s, s.events.length - 1, stored);
      seqs.push({ sequence_num: s.events.length, duplicate: false });
    }
    s.lastSeenAt = Date.now();
    this.log(`[rc] ${s.id} ingest ${envelopes?.length ?? 0} event(s) (total=${s.events.length})`);
    return { results: seqs };
  }

  // ── 下行:SSE 订阅 ─────────────────────────────────────────────────
  // SSE 订阅。客户端(EventSource 语义)会在连接建立后立刻发一次请求,
// 但它只认 `id:` 行做续传;我们把 sequence_num 作为 id 回写,断线重连才带得回来。
subscribe(s, req, res, fromSeq) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'anthropic-session-service': 'cc-cloud',
    });
    res.write(': cc-cloud stream open\n\n');
    s.subscribers.add(res);
    this.log(`[rc] ${s.id} SSE 订阅 (subscribers=${s.subscribers.size}, from=${fromSeq ?? 'tail'})`);

    const keep = setInterval(() => res.write(': ping\n\n'), 15000);
    const drop = () => {
      clearInterval(keep);
      if (s.subscribers.delete(res)) this.log(`[rc] ${s.id} SSE 断开 (subscribers=${s.subscribers.size})`);
    };
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);
  }

  // web 控制端订阅:先补发 after 之后的历史事件,再实时增量。
  subscribeWeb(s, req, res, after = 0) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(': open\n\n');
    for (let i = Math.max(0, after); i < s.events.length; i++) {
      res.write(`id: ${i}\ndata: ${JSON.stringify({ index: i, event: s.events[i] })}\n\n`);
    }
    s.webSubs.add(res);
    this.log(`[rc] ${s.id} web 订阅 (webSubs=${s.webSubs.size}, after=${after})`);
    const keep = setInterval(() => { try { res.write(': ping\n\n'); } catch { } }, 15000);
    const drop = () => { clearInterval(keep); if (s.webSubs.delete(res)) this.log(`[rc] ${s.id} web 断开 (webSubs=${s.webSubs.size})`); };
    req.on('close', drop); req.on('error', drop); res.on('error', drop);
  }

  // 把一条新上行事件实时推给 web 订阅者
  _fanoutWeb(s, index, event) {
    if (!s.webSubs || !s.webSubs.size) return;
    const wire = `id: ${index}\ndata: ${JSON.stringify({ index, event })}\n\n`;
    for (const res of s.webSubs) { try { res.write(wire); } catch { } }
  }

  // 推一帧给所有订阅者。
  // 形状必须与官方一致:顶层 `{sequence_num, event_id, event_type, payload:{…}}`,
  // 真实内容放在 `payload` 里;而且必须有 `id:` 行,否则客户端 EventSource
  // 记不住续传点,重连时不会带 from_sequence_num。
  push(s, frame) {
    if (!s.subscribers.size) return false;
    const seq = ++s.seq;
    const data = JSON.stringify({
      sequence_num: seq,
      event_id: crypto.randomUUID(),
      event_type: frame.type,
      payload: { ...frame },
    });
    const wire = `id: ${seq}\nevent: client_event\ndata: ${data}\n\n`;
    for (const res of s.subscribers) { try { res.write(wire); } catch { } }
    this.log(`[rc] ${s.id} → ${frame.type} #${seq} (subscribers=${s.subscribers.size})`);
    return true;
  }

  // 发一个 control_request 并等 control_response
  request(s, subtype, body = {}, timeoutMs = 120000) {
    return new Promise((resolve) => {
      const requestId = `cr_${crypto.randomBytes(12).toString('hex')}`;
      const frame = { type: 'control_request', request_id: requestId, request: { subtype, ...body } };
      s.pending.push({ requestId, subtype, resolve, timer: null });
      const entry = s.pending[s.pending.length - 1];
      entry.timer = setTimeout(() => {
        const i = s.pending.indexOf(entry);
        if (i >= 0) s.pending.splice(i, 1);
        resolve({ subtype: 'error', error: `${subtype} timed out` });
      }, timeoutMs);
      this.log(`[rc] ${s.id} → control_request ${subtype} request_id=${requestId}`);
      if (!this.push(s, frame)) this.log(`[rc] ${s.id} 无订阅者,${subtype} 留在队列`);
    });
  }

  respond(s, requestId, response) {
    const i = s.pending.findIndex((p) => p.requestId === requestId);
    if (i < 0) return false;
    const [entry] = s.pending.splice(i, 1);
    clearTimeout(entry.timer);
    this.log(`[rc] ${s.id} ← control_response ${entry.subtype} request_id=${requestId}`);
    entry.resolve(response);
    return true;
  }
}