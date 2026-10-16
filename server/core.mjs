// ═══ cc-cloud:API 核心(与传输层解耦)═══
//
// 同一套 handler 有两个挂载点:
//   1. index.mjs  → https://api.anthropic.com:443(MITM,给"看起来像官方"的部署用)
//   2. sock.mjs   → $ANTHROPIC_UNIX_SOCKET(AF() 隧道模式,首选)
//
// 关键:控制面(/v1/code/sessions*、policy_limits、features、trusted_devices)
// 与推理面(/v1/messages)在同一个 socket 上共存。客户端侧把
// ANTHROPIC_AUTH_TOKEN 清掉(AF() 要求),由本进程把第三方凭据补回代理请求头,
// 于是"RC 走我们、推理走第三方"这条缝在传输层就成立了。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SessionStore } from './rc.mjs';
import { createMailer } from './mail.mjs';
import { createFcm } from './fcm.mjs';
import { AccountStore, DEFAULT_SEED_ACCOUNT } from './accounts.mjs';

// 会话持久化:存 ~/.config/cc-cloud/(与 app-sign.jks 同处,不进仓库),重启不丢用户会话
const CC_DATA_DIR = process.env.CC_DATA_DIR || path.join(os.homedir(), '.config', 'cc-cloud');
const CONV_FILE = path.join(CC_DATA_DIR, 'conversations.json');

const readBody = (req) => new Promise((res) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b));
});
// 二进制读体:上传走 multipart,不能按字符串拼(会毁字节),按 Buffer 收
const readBodyBuffer = (req) => new Promise((res) => {
  const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => res(Buffer.concat(chunks)));
});
// 极简 multipart/form-data 解析:按 boundary 切片,返回 [{headers(文本), body(Buffer)}]。只为上传单 part("file")够用。
function parseMultipart(buf, contentType) {
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!bm) return [];
  const bb = Buffer.from('--' + (bm[1] || bm[2]).trim());
  const parts = [];
  let start = buf.indexOf(bb);
  if (start < 0) return [];
  start += bb.length;
  while (start < buf.length) {
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break;      // 收尾的 "--"
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;  // 跳过 CRLF
    const next = buf.indexOf(bb, start);
    if (next < 0) break;
    let end = next;
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;    // 去掉 part 末尾 CRLF
    const part = buf.slice(start, end);
    const sep = part.indexOf('\r\n\r\n');
    if (sep >= 0) parts.push({ headers: part.slice(0, sep).toString('utf8'), body: part.slice(sep + 4) });
    start = next + bb.length;
  }
  return parts;
}

export function createCore({ log, features = {}, upstream, upstreamToken, upstreamHeaders = {}, accounts, smtp, fcmServiceAccountPath }) {
  const RC = new SessionStore(log);
  const ACCOUNTS = accounts || new AccountStore(log); // 未传入(如 proxy.mjs)→ 内置单种子内存账号,行为与改造前一致
  const mailer = createMailer({ log, config: smtp }); // config 为空时 createMailer 自己退回读 config/smtp.json(向后兼容)
  const otpStore = new Map(); // email(lower) -> { code, exp, tries }
  const convStore = new Map(); // convId -> { ...元数据, messages:[{uuid,parent_uuid,role,text}] },落盘持久化
  const nowISO = () => new Date().toISOString();
  function convEnsure(id, init = {}) {
    let e = convStore.get(id);
    if (!e) { const now = nowISO(); e = { uuid: id, name: '', summary: '', model: null, project_uuid: null, created_at: now, updated_at: now, current_leaf_message_uuid: null, is_starred: false, is_temporary: false, messages: [], ...init }; convStore.set(id, e); }
    return e;
  }
  const convMeta = (e) => ({ uuid: e.uuid, name: e.name || '', summary: e.summary || '', model: e.model ?? null, settings: {}, project_uuid: e.project_uuid ?? null, is_starred: !!e.is_starred, is_temporary: !!e.is_temporary, created_at: e.created_at, updated_at: e.updated_at, current_leaf_message_uuid: e.current_leaf_message_uuid ?? null });
  const convList = () => [...convStore.values()].filter((e) => !e.is_temporary).sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  function saveConv() {
    try { fs.mkdirSync(CC_DATA_DIR, { recursive: true }); const o = {}; for (const [k, v] of convStore) o[k] = v; fs.writeFileSync(CONV_FILE, JSON.stringify(o)); }
    catch (e) { log(`[chat] 会话写盘失败 ${e.message}`); }
  }
  try { const o = JSON.parse(fs.readFileSync(CONV_FILE, 'utf8')); for (const k of Object.keys(o)) convStore.set(k, o[k]); log(`[chat] 载入 ${convStore.size} 个持久化会话`); } catch { /* 首次无文件 */ }
  // 项目持久化(同 convStore 落盘模式):POST 落库 → projects_v2 列出 → GET projects/{id} 读回
  const projectStore = new Map(); // projId -> Project 对象
  const PROJ_FILE = path.join(CC_DATA_DIR, 'projects.json');
  const projMake = (id, b = {}) => { const now = nowISO(); return { uuid: id, name: b.name || 'Untitled', is_private: b.is_private !== false, created_at: now, updated_at: now, description: b.description ?? null, docs_count: 0, files_count: 0, is_starred: false, is_starter_project: false, type: null, subtype: null, permissions: null, prompt_template: null, is_upgraded: false, memory_general_enabled: false, memory_general_switch_visible: false, archived_at: null, archiver: null, creator: null, moved_to: null }; };
  function saveProj() { try { fs.mkdirSync(CC_DATA_DIR, { recursive: true }); const o = {}; for (const [k, v] of projectStore) o[k] = v; fs.writeFileSync(PROJ_FILE, JSON.stringify(o)); } catch (e) { log(`[proj] 写盘失败 ${e.message}`); } }
  try { const o = JSON.parse(fs.readFileSync(PROJ_FILE, 'utf8')); for (const k of Object.keys(o)) projectStore.set(k, o[k]); log(`[proj] 载入 ${projectStore.size} 个项目`); } catch { /* 首次无文件 */ }
  // 通知偏好持久化:feature_preference = { <feature>: {enable_email,enable_push} }(8 feature:compass/completion/bogosort/code_requires_action/dispatch/hearth_project/marketing/routines)
  const NOTIF_FILE = path.join(CC_DATA_DIR, 'notif_prefs.json');
  let notifFP = {};
  const saveNotif = () => { try { fs.mkdirSync(CC_DATA_DIR, { recursive: true }); fs.writeFileSync(NOTIF_FILE, JSON.stringify(notifFP)); } catch (e) { log(`[notif] 写盘失败 ${e.message}`); } };
  try { notifFP = JSON.parse(fs.readFileSync(NOTIF_FILE, 'utf8')) || {}; } catch { notifFP = {}; }
  // vum 响应:preferences=q3p{feature_preference:zse},effective_preferences=Map<String,EffectiveChannelPreference{enable_push}>
  // ⚠️切换开关"点击无效"真因:App 从 effective_preferences 回读开关态,回空 Map→开关恒 off 回弹。必须按 feature_preference 算出每个 feature 的 enable_push
  const notifResp = () => {
    const eff = {};
    for (const [k, v] of Object.entries(notifFP)) if (v && typeof v === 'object') eff[k] = { enable_push: v.enable_push === true };
    return { preferences: { feature_preference: notifFP }, effective_preferences: eff };
  };
  // FCM 推送通道:注册的设备 token(POST notification/channels 落库,completion 完成时推送)。按 registration_token 去重。
  const CHAN_FILE = path.join(CC_DATA_DIR, 'notif_channels.json');
  const chanStore = new Map(); // registration_token -> channel 对象(含 uuid/status 等)
  const saveChan = () => { try { fs.mkdirSync(CC_DATA_DIR, { recursive: true }); fs.writeFileSync(CHAN_FILE, JSON.stringify([...chanStore.values()])); } catch (e) { log(`[notif] 通道写盘失败 ${e.message}`); } };
  try { for (const c of JSON.parse(fs.readFileSync(CHAN_FILE, 'utf8'))) if (c && c.registration_token) chanStore.set(c.registration_token, c); } catch { /* 首次无文件 */ }
  // 默认路径落在 CC_DATA_DIR(家目录下,物理上不在仓库工作目录里)——不是仓库里的 config/,
  // 因为这是账号级运行时凭据,和 users.json/accounts.json 同一归属;路径隔离 + .gitignore
  // 双保险,不会被不小心 git add 进去。调用方(app.mjs/proxy.mjs)可用 CC_FCM_SA 指到别处。
  const fcm = createFcm({ serviceAccountPath: fcmServiceAccountPath || path.join(CC_DATA_DIR, 'firebase-adminsdk.json'), log });
  // completion 完成后给所有已注册 token 推 data-only 消息(前台会被 App 自行抑制)。payload=proto3-JSON 字符串(非 base64)
  async function pushCompletion(convId, bodyText, account) {
    if (!fcm.enabled || chanStore.size === 0) return;
    const payload = JSON.stringify({
      service: '', method: 'OpenChat',
      request: { '@type': 'type.googleapis.com/anthropic.claude.push.OpenChatRequest', account_uuid: account.uuid, organization_uuid: account.org_uuid, conversation_uuid: convId },
    });
    const body = (bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Claude 已完成回复';
    const data = { notification_feature_category: 'completion', title: 'Claude', body, payload };
    for (const [token, ch] of [...chanStore]) {
      if (ch.status && ch.status !== 'ACTIVE') continue;
      const r = await fcm.send({ token, data, android: { priority: 'high' } }).catch((e) => ({ ok: false, status: 0, body: String(e.message) }));
      if (r.ok) log(`[fcm] 推送完成 conv=${convId} token=…${token.slice(-8)}`);
      else { log(`[fcm] 推送失败 ${r.status} ${String(r.body).slice(0, 160)}`); if (r.status === 404 || /UNREGISTERED|InvalidRegistration/.test(String(r.body))) { chanStore.delete(token); saveChan(); } }
    }
  }
  const modelStateStore = new Map(); // surface -> ModelSelectorState(用户在 UI 选的模型/thinking,PATCH 落库)
  // 文件存储:上传的文件字节落盘 CC_DATA_DIR/files/{uuid},元数据落 files_meta.json。预览/下载按 file_uuid 服字节。
  const FILES_DIR = path.join(CC_DATA_DIR, 'files');
  const FILES_META = path.join(CC_DATA_DIR, 'files_meta.json');
  const fileStore = new Map(); // file_uuid -> { file_uuid, file_name, mime, size_bytes, kind, created_at, image_width?, image_height? }
  const saveFiles = () => { try { fs.mkdirSync(CC_DATA_DIR, { recursive: true }); fs.writeFileSync(FILES_META, JSON.stringify([...fileStore.values()])); } catch (e) { log(`[file] 元数据写盘失败 ${e.message}`); } };
  try { for (const f of JSON.parse(fs.readFileSync(FILES_META, 'utf8'))) if (f && f.file_uuid) fileStore.set(f.file_uuid, f); } catch { /* 首次无文件 */ }
  const fileBytesPath = (uuid) => path.join(FILES_DIR, uuid);
  // 会话分享:POST .../chat_conversations/{conv}/share 建"快照"(ChatSnapshotSummary),App 用 响应.uuid 拼 {origin}/share/{uuid} 做分享链接。
  const SNAP_FILE = path.join(CC_DATA_DIR, 'snapshots.json');
  const snapStore = new Map(); // snapshot_uuid -> { uuid, snapshot_name, created_at, updated_at, conversation_uuid, project_uuid, visibility, snap_n }
  const saveSnaps = () => { try { fs.mkdirSync(CC_DATA_DIR, { recursive: true }); fs.writeFileSync(SNAP_FILE, JSON.stringify([...snapStore.values()])); } catch (e) { log(`[share] 快照写盘失败 ${e.message}`); } };
  try { for (const s of JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'))) if (s && s.uuid) snapStore.set(s.uuid, s); } catch { /* 首次无分享 */ }
  const snapByConv = (cid) => { for (const s of snapStore.values()) if (s.conversation_uuid === cid) return s; return null; };
  // f67 ChatSnapshotSummary:uuid/snapshot_name/created_at/updated_at 必填,project_uuid/visibility 可选(visibility 枚举序列名 invite_only/org/public/unknown)
  const snapSummary = (s) => ({ uuid: s.uuid, snapshot_name: s.snapshot_name, created_at: s.created_at, updated_at: s.updated_at, project_uuid: s.project_uuid ?? null, visibility: s.visibility || 'public' });
  // i67 ChatSnapshotSummaryWithChatId:同上 + conversation_uuid 必填,但【无 visibility 字段】
  const snapSummaryWithChat = (s) => ({ uuid: s.uuid, snapshot_name: s.snapshot_name, created_at: s.created_at, updated_at: s.updated_at, project_uuid: s.project_uuid ?? null, conversation_uuid: s.conversation_uuid });
  // smp ProjectCreator:uuid 必填,full_name/email 可选(位掩码 0x1)。分享快照的作者=分享那一刻的账户,
  // 固定存进 snapshot 记录(s.creator,见 POST .../share),不是读取时的当前账户——账户可能已改名/被删。
  const snapCreatorFrom = (account) => ({ uuid: account.uuid, full_name: account.full_name, email: account.email });
  // 快照内 chat_messages 元素=jh6(com.anthropic.claude.api.chat.ChatMessage,与重开会话同型)。复用会话详情那套气泡形状(content 块才渲染,text 仅预览)。
  const snapChatMessages = (conv, snapN) => {
    const all = conv ? conv.messages : [];
    const msgs = (typeof snapN === 'number' && snapN >= 0) ? all.slice(0, snapN) : all;
    const cat = conv ? conv.created_at : nowISO(), uat = conv ? (conv.updated_at || conv.created_at) : nowISO();
    return msgs.map((m, i) => ({
      uuid: m.uuid, parent_message_uuid: m.parent_uuid ?? null, index: i,
      created_at: cat, updated_at: uat, text: m.text,
      content: [{ type: 'text', text: m.text, stop_timestamp: uat }],
      sender: m.role === 'assistant' ? 'assistant' : 'human', attachments: [], files: [],
      stop_reason: m.role === 'assistant' ? (m.stop_reason || 'end_turn') : null,
    }));
  };
  // t57 ChatSnapshot(分享页读取):uuid/snapshot_name/is_public/created_at/updated_at/creator 必填;project_uuid/chat_messages 可选(位掩码 0x5f)
  const snapshotFull = (s) => {
    const conv = convStore.get(s.conversation_uuid);
    return {
      uuid: s.uuid, snapshot_name: s.snapshot_name, is_public: (s.visibility || 'public') === 'public',
      created_at: s.created_at, updated_at: s.updated_at, project_uuid: s.project_uuid ?? null,
      // 旧快照(改造前创建,无 s.creator)兜底回种子账号信息,不崩
      creator: s.creator || { uuid: DEFAULT_SEED_ACCOUNT.uuid, full_name: DEFAULT_SEED_ACCOUNT.full_name, email: DEFAULT_SEED_ACCOUNT.email },
      chat_messages: snapChatMessages(conv, s.snap_n),
    };
  };
  const fileAssetUrl = (orgUuid, uuid) => `/api/organizations/${orgUuid}/files/${uuid}/contents`; // 源相对单 / 开头;App Coil 带鉴权原样 GET

  // ── 分享链接页面(2026-10-15 实证修复):App 用 响应.uuid 拼 {origin}/share/{uuid},这是个**不带 /api 前缀**的浏览器页面,
  //   不是 JSON 契约;早前没拦截就落进 handle() 最终 else 分支 → 被当成推理请求 infer() 转发到 UPSTREAM → 上游 404。
  //   这里手搓一个只读渲染页(不依赖任何库),必须注册在 infer 兜底之前。
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // 极简文本转 HTML:```块```→<pre><code>,单反引号→<code>,换行→<br>。只服务只读分享页,不追求完整 markdown。
  function formatMsgHtml(text) {
    const src = String(text || '');
    const parts = []; let last = 0;
    const codeBlockRe = /```[a-zA-Z0-9_+-]*\n?([\s\S]*?)```/g;
    let m;
    while ((m = codeBlockRe.exec(src))) {
      if (m.index > last) parts.push({ code: false, text: src.slice(last, m.index) });
      parts.push({ code: true, text: m[1] });
      last = codeBlockRe.lastIndex;
    }
    if (last < src.length) parts.push({ code: false, text: src.slice(last) });
    return parts.map((part) => part.code
      ? `<pre><code>${escapeHtml(part.text)}</code></pre>`
      : escapeHtml(part.text).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>')
    ).join('');
  }
  function sendHtml(res, html, code = 200) {
    const b = Buffer.from(html, 'utf8');
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'content-length': b.length });
    res.end(b);
  }
  function shareNotFoundHtml() {
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>分享不存在</title>
<style>body{background:#F0ECE0;color:#1a1a18;font-family:ui-serif,Georgia,Cambria,"Times New Roman",Times,serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
@media (prefers-color-scheme: dark){body{background:#2b2a27;color:#eee}}
div{text-align:center;padding:0 24px}</style></head>
<body><div><h2>此分享不存在或已取消</h2><p style="opacity:.65">链接可能已失效,或分享者已取消分享</p></div></body></html>`;
  }
  function sharePageHtml(snap) {
    const title = escapeHtml(snap.snapshot_name || 'Shared conversation');
    const creatorName = escapeHtml(snap.creator && snap.creator.full_name || '用户');
    const msgs = snap.chat_messages.map((m) => {
      const isAsst = m.sender === 'assistant';
      return `<div class="msg ${isAsst ? 'asst' : 'human'}"><div class="who">${isAsst ? 'Claude' : creatorName}</div><div class="bubble">${formatMsgHtml(m.text)}</div></div>`;
    }).join('\n');
    return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  /* 配色/圆角/衬线字体 token 取自开源 assistant-ui 项目的 "Claude Clone" 主题示例
     (github.com/assistant-ui/assistant-ui,MIT,apps/docs/.../examples/claude.tsx)——
     这是别人专门做的"照 Claude.ai 观感主题化"参考实现,不是扒 claude.ai 自己编译的 CSS/字体
     (直连 claude.ai 实测 HTTP 403,有机器人拦截,且 Next.js 编译产物是哈希化原子类,拿来也装不上静态页)。 */
  :root { --bg:#F0ECE0; --fg:#1a1a18; --sub:#5b5950; --bubble-human:#E5E0D6; --bubble-asst:#ffffff; --border:#E5E0D6; --accent:#c96442; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#2b2a27; --fg:#eeeeee; --sub:#a3a098; --bubble-human:#393937; --bubble-asst:#1f1e1b; --border:#3d3a35; --accent:#c96442; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-family:ui-serif,Georgia,Cambria,"Times New Roman",Times,serif; }
  header { padding:20px 16px 14px; border-bottom:1px solid var(--border); }
  header h1 { margin:0; font-size:17px; font-weight:600; word-wrap:break-word; }
  header p { margin:4px 0 0; font-size:13px; color:var(--sub); }
  main { max-width:720px; margin:0 auto; padding:16px; }
  .msg { margin:0 0 18px; display:flex; flex-direction:column; }
  .msg.human { align-items:flex-end; }
  .msg.asst { align-items:flex-start; }
  .who { font-size:12px; color:var(--sub); margin:0 4px 4px; }
  .bubble { max-width:80%; padding:10px 16px; border-radius:16px; line-height:1.6; font-size:16px; word-wrap:break-word; }
  .msg.human .bubble { background:var(--bubble-human); border-bottom-right-radius:4px; }
  .msg.asst .bubble { background:var(--bubble-asst); border:1px solid var(--border); border-bottom-left-radius:4px; }
  .bubble pre { background:rgba(127,127,127,.12); padding:10px; border-radius:8px; overflow-x:auto; font-size:13px; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .bubble code { background:rgba(127,127,127,.15); padding:1px 5px; border-radius:4px; font-size:0.9em; font-family:ui-monospace,Menlo,Consolas,monospace; }
  .bubble pre code { background:none; padding:0; }
  footer { max-width:720px; margin:0 auto; padding:8px 16px 32px; font-size:12px; color:var(--sub); text-align:center; }
</style>
</head>
<body>
<header><h1>${title}</h1><p>只读分享 · 由 <span style="color:var(--accent)">${creatorName}</span> 分享</p></header>
<main>${msgs || '<p style="color:var(--sub)">(空会话)</p>'}</main>
<footer>此链接为只读分享快照,内容不会随原会话更新而变化。</footer>
</body>
</html>`;
  }

  // 上传响应:按 MIME 回对应 MessageFile 变体(sealed 判别键 file_kind)。image→内联预览;pdf→document 文档预览(dil/dfl 均仅 url 必填,已核);其余→blob(字段最少不崩)
  function messageFileResp(meta, account) {
    const base = { file_uuid: meta.file_uuid, file_name: meta.file_name, created_at: meta.created_at, size_bytes: meta.size_bytes };
    const u = fileAssetUrl(account.org_uuid, meta.file_uuid);
    if ((meta.mime || '').startsWith('image/')) {
      const asset = { url: u, ...(meta.image_width ? { image_width: meta.image_width } : {}), ...(meta.image_height ? { image_height: meta.image_height } : {}) };
      return { file_kind: 'image', ...base, thumbnail_asset: asset, preview_asset: asset }; // thumbnail_asset 必填;preview_asset 预览优先
    }
    if (meta.mime === 'application/pdf') return { file_kind: 'document', ...base, thumbnail_asset: { url: u }, document_asset: { url: u } };
    return { file_kind: 'blob', ...base, text_extracted: false };
  }
  // 完成请求把上传文件注入上游 messages:cr.files=裸 file_uuid 数组→查 fileStore 读字节→转 content block
  function fileBlocks(uuids) {
    const blocks = [];
    for (const u of uuids || []) {
      const meta = fileStore.get(u); if (!meta) continue;
      let buf; try { buf = fs.readFileSync(fileBytesPath(u)); } catch { continue; }
      const mime = meta.mime || 'application/octet-stream';
      if (mime.startsWith('image/')) blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } });
      else if (mime === 'application/pdf') blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } });
      else if (mime.startsWith('text/') || /json|xml|yaml|javascript|csv|markdown/.test(mime)) blocks.push({ type: 'text', text: `[文件 ${meta.file_name || u}]\n${buf.toString('utf8').slice(0, 200000)}` });
      else blocks.push({ type: 'text', text: `[已上传文件 ${meta.file_name || u}(${mime},${meta.size_bytes || buf.length} 字节)]` });
    }
    return blocks;
  }
  // 历史消息→上游 content:无文件/附件→纯字符串(省流);有→块数组(文件在前、prompt 文本在后)
  function buildUpContent(m) {
    const blocks = [];
    if (m.role === 'user') {
      blocks.push(...fileBlocks(m.files));
      for (const a of m.atts || []) if (a && a.text) blocks.push({ type: 'text', text: `[附件 ${a.name || ''}]\n${a.text}` });
    }
    if (blocks.length === 0) return m.text || '';
    if (m.text) blocks.push({ type: 'text', text: m.text });
    return blocks;
  }
  const activeCompletions = new Map(); // convId -> AbortController(进行中的 completion,供 stop_response 中止)
  // 孤儿端点(无 org 路径段,如 /api/account)按连接级 stash(req.socket._ccAccount)+ 这个全局指针兜底解析账号。
  // 多账号同时活跃时这几个纯展示端点可能有小概率"串场"(见计划文档已知限制),不影响任何按 org 精确隔离的业务数据。
  let lastActiveAccountUuid = DEFAULT_SEED_ACCOUNT.uuid;

  const bearer = (req) => {
    const a = req.headers.authorization || '';
    return a.startsWith('Bearer ') ? a.slice(7) : null;
  };

  // ── 特性开关(取代 GrowthBook)───────────────────────────────────────
  function growthbook(res, pathname) {
    const feats = {};
    let n = 0;
    for (const k of Object.keys(features)) { feats[k] = { value: features[k], source: 'override' }; n++; }
    const body = JSON.stringify({ status: 200, features: feats, dateUpdated: new Date().toISOString() });
    log(`[gb] ${pathname} -> ${n} flags`);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  // ── RC v2 会话端点 ────────────────────────────────────────────────
  async function remote(req, res, url, base, ctx = {}) {
    const p = url.pathname;

    // 无 Authorization 也放行:隧道模式下客户端按 firstParty/proxy 走,不带 token。
    const token = bearer(req);

    if (p === '/v1/code/sessions' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const s = RC.create({
        userId: ctx.workerUserId || 'cc-cloud', title: body.title, cwd: body.config?.cwd,
        model: body.config?.model, tags: body.tags,
        deviceToken: req.headers['x-trusted-device-token'],
      });
      log(`[rc] POST /v1/code/sessions -> ${s.id}`);
      res.writeHead(201, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        session: { id: s.id, status: 'active', title: s.title, created_at: new Date(s.createdAt).toISOString() },
      }));
    }

    const m = p.match(/^\/v1\/code\/sessions\/([^/]+)(?:\/(.*))?$/);
    if (!m) return false;
    const [, sid, rest] = m;
    const s = RC.get(sid);
    if (!s) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'session not found' } }));
    }

    // 隔离:带 worker 身份时,只能碰自己 user 的 session(不暴露存在性,一律 404)
    if (ctx.workerUserId && s.userId !== ctx.workerUserId) {
      log(`[rc] ${sid} 跨用户拒绝 owner=${s.userId} caller=${ctx.workerUserId}`);
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { type: 'not_found_error', message: 'session not found' } }));
    }

    if (rest === 'bridge' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.expected_epoch !== undefined && body.expected_epoch !== s.epoch) {
        log(`[rc] ${sid} /bridge epoch 冲突 stated=${body.expected_epoch} actual=${s.epoch} -> 409`);
        res.writeHead(409, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { type: 'epoch_conflict', expected_epoch: body.expected_epoch, actual_epoch: s.epoch } }));
      }
      // 隧道模式下 base 用客户端能解析的 http://localhost(AF() 把 base 指向它)
      log(`[rc] ${sid} /bridge -> worker_jwt (epoch=${s.epoch})`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        worker_jwt: s.jwt, api_base_url: base, expires_in: 3600, worker_epoch: s.epoch,
      }));
    }

    // GET /worker/events/stream —— SSE 下行
    if (rest === 'worker/events/stream' && req.method === 'GET') {
      RC.subscribe(s, req, res, url.searchParams.get('from_sequence_num'));
      return true;
    }
    // POST /worker/events —— 上行事件(control_response 在这里应答下行的 control_request)
    if (rest === 'worker/events' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(RC.ingest(s, body.events)));
    }
    if (rest === 'worker/events/delivery' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      for (const u of body.updates || body.deliveries || []) {
        if (u?.uuid) s.delivery.set(u.uuid, { sequence_num: u.sequence_num, duplicate: true });
      }
      log(`[rc] ${sid} delivery 回执 ${(body.updates || body.deliveries || []).length} 条`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    // GET /worker —— 查会话状态(客户端轮询用)
    if (rest === 'worker' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        session_id: s.id, worker_epoch: s.epoch, worker_status: s.state,
        title: s.title, model: s.model, created_at: new Date(s.createdAt).toISOString(),
        last_seen_at: new Date(s.lastSeenAt).toISOString(),
      }));
    }
    if (rest === 'worker' && req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)) || '{}');
      if (body.worker_epoch !== undefined && body.worker_epoch !== s.epoch) {
        res.writeHead(409, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { type: 'epoch_stale', expected_epoch: s.epoch, actual_epoch: body.worker_epoch } }));
      }
      if (body.worker_status) s.state = body.worker_status;
      log(`[rc] ${sid} worker 状态=${s.state}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, worker_epoch: s.epoch }));
    }
    if (rest === 'worker/heartbeat' && req.method === 'POST') {
      s.lastSeenAt = Date.now();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, worker_epoch: s.epoch, server_now: Date.now() }));
    }
    if (rest === 'worker/register' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ worker_epoch: s.epoch }));
    }
    if (rest === 'archive' && req.method === 'POST') {
      RC.drop(sid, 'archived');
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    if (rest === 'unarchive' && req.method === 'POST') {
      s.expiresAt = Date.now() + RC.ttlMs;
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    }
    // 控制端在线状态(App 前台轮询);无副作用,回 200 + 当前状态
    if (rest === 'client/presence' && req.method === 'POST') {
      s.lastSeenAt = Date.now();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, worker_status: s.state, worker_epoch: s.epoch }));
    }

    log(`[rc] ${sid} 未实现的子路径 ${req.method} ${rest}`);
    res.writeHead(404, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { type: 'not_found_error', message: `unimplemented ${rest}` } }));
  }

  // ── 其余第一方端点 ────────────────────────────────────────────────
  function policy(res, p) {
    const body = JSON.stringify({
      restrictions: {
        allow_remote_control: { allowed: true },
        allow_remote_sessions: { allowed: true },
      },
      compliance_taints: [], monitoring_notice: null,
      defaults: { remote_control_at_startup: true },
    });
    log(`[api] ${p} -> 200 policy-limits(allow_remote_control:true)`);
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  async function trustedDevice(req, res) {
    const b = JSON.parse((await readBody(req)) || '{}');
    const deviceToken = `ccd_${crypto.randomBytes(24).toString('hex')}`;
    const deviceId = `dev_${crypto.randomBytes(8).toString('hex')}`;
    log(`[api] trusted_devices "${b.display_name || '(无名)'}" -> ${deviceId}`);
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ device_token: deviceToken, device_id: deviceId }));
  }

  function oauthToken(res, account) {
    const body = JSON.stringify({
      access_token: 'cc-cloud-at', refresh_token: 'cc-cloud-rt',
      expires_in: 3600, token_type: 'Bearer',
      scope: 'user:inference user:profile user:office user:ccr_inference',
      organization: { uuid: account.org_uuid, name: 'cc-cloud' },
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  }

  // OAuth scope 校验:客户端启动时会问,我们全给
  function oauthValidate(res, account) {
    const body = JSON.stringify({
      valid: true, scopes: ['user:inference', 'user:profile', 'user:office', 'user:ccr_inference'],
      organization: { uuid: account.org_uuid, name: 'cc-cloud' },
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
  }

  const sendJson = (res, obj, code = 200, extraHeaders = {}) => {
    const b = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(b), ...extraHeaders });
    res.end(b);
  };
  // App 账户资料(字段名逆向自 base.apk:account/organization/display_name/rate_limit/capabilities/billing_type)
  function oauthProfile(res, account) {
    sendJson(res, {
      account: {
        uuid: account.uuid, email_address: account.email,
        full_name: account.full_name, display_name: account.display_name,
        has_claude_pro: true, has_claude_max: true,
      },
      organization: {
        uuid: account.org_uuid, name: 'cc-cloud', organization_type: 'claude_max',
        billing_type: 'subscription', rate_limit_tier: 'default',
        capabilities: ['chat', 'claude_pro', 'claude_max', 'remote_control'],
      },
    });
  }
  // App 启动引导(字段逆向自 dex:update_required/force_upgrade/server_time)。登录前通用端点,不绑定具体账号。
  function appBootstrap(res) {
    sendJson(res, {
      update_required: false, force_upgrade: false, maintenance_mode: false,
      minimum_version: '0.0.1', server_time: new Date().toISOString(),
      organization: { uuid: DEFAULT_SEED_ACCOUNT.org_uuid, name: 'cc-cloud' },
    });
  }

  // ── App 手机端:登录后控制面(路径逆向自 app.log 实际请求)──────────
  // Organization 模型:严格匹配 app dex 的 api/account/Organization(必填 uuid/name/settings/capabilities;
  // 勿加 organization_type 等模型外字段,strict kotlinx 会因未知键报错)。下面几个都是"账号 -> App 契约形状"的
  // 纯派生函数(不持有状态),取代改造前的全局字面量 ORG_MODEL/MEMBERSHIP/ACCOUNT/ORG。
  const orgModel = (account) => ({
    uuid: account.org_uuid, name: account.display_name || 'cc-cloud',
    settings: { claude_console_privacy: 'disabled' }, // OrganizationSettings 必填 claude_console_privacy(String)
    capabilities: ['chat', 'claude_pro', 'claude_max', 'remote_control'],
    billing_type: 'subscription', rate_limit_tier: 'default', // 可选,App 会读,给上
  });
  // Membership 五字段全必填(organization/role/created_at/updated_at/notification_preferences)。
  // App 登录后对 account.memberships 取首元素,空列表 -> NoSuchElementException 崩溃,故必须给一条。
  const membershipModel = (account) => ({
    organization: orgModel(account), role: 'admin',
    created_at: account.created_at, updated_at: account.updated_at,
    notification_preferences: {}, // Preferences 字段全可选,{} 合法
  });
  const accountToApp = (account) => ({
    uuid: account.uuid, email_address: account.email,
    full_name: account.full_name, display_name: account.display_name, is_verified: account.is_verified,
    created_at: account.created_at, updated_at: account.updated_at,
    memberships: [membershipModel(account)], settings: account.settings || {},
  });
  // GET /api/account/profile —— 当前账户(App 判断是否已登录的关键)
  function accountProfile(res, account) { sendJson(res, { account: accountToApp(account), organizations: [orgModel(account)] }); }
  // GET /api/bootstrap —— 启动引导(账户 + 组织 + 开关 + 服务器时间)
  function bootstrap(res, account) {
    sendJson(res, {
      account: accountToApp(account), organization: orgModel(account), organizations: [orgModel(account)],
      update_required: false, force_upgrade: false, maintenance_mode: false,
      minimum_version: '0.0.1', server_time: new Date().toISOString(),
      settings: {}, flags: {},
    });
  }
  // GET /api/legal —— 法律条款状态(全部已接受,免弹窗)
  function legal(res) {
    sendJson(res, { documents: [], acceptance_required: false, terms_accepted: true, privacy_accepted: true });
  }
  // GET /api/organizations/{id} —— 组织详情
  function organization(res, account) { sendJson(res, orgModel(account)); }
  // GET /v1/projects/{id}/settings —— 项目设置(默认空)
  function projectSettings(res) { sendJson(res, { settings: {} }); }
  // thinking 档位(逆向 ThinkingOption{id,name,description?,recommended,badge?});completion 把 effort 翻成上游 thinking budget
  const THINKING_OPTIONS = [
    { id: 'none', name: '标准', description: null, recommended: false, badge: null },
    { id: 'low', name: '低', description: null, recommended: false, badge: null },
    { id: 'medium', name: '中', description: null, recommended: true, badge: null },
    { id: 'high', name: '高', description: null, recommended: false, badge: null },
    { id: 'max', name: '最大', description: null, recommended: false, badge: null },
  ];
  // model_selector:id 必须是上游真实模型(实测经 new-api 可转换);claude-opus-4-8 anthropic 原生+thinking,grok-4.6 已测通
  // 上游还有 deepseek/gemini/qwen 等几十个 openai 系都能转换,要加哪些逐个追加即可
  const MODEL_ENTRIES = [
    ['claude-opus-4-8', 'Claude Opus 4.8', 'Opus 4.8', 'Anthropic 原生 · 支持思考'],
    ['grok-4.6', 'Grok 4.6', 'Grok', 'xAI · 经上游转换'],
  ].map(([id, name, short_name, desc]) => ({
    id, model: id, name, short_name,
    description: desc,
    section: 'main', capabilities: {},
    thinking: { effort_options: THINKING_OPTIONS, mode_options: [], description: null },
    disabled: false, badge: null, notice: null, selection_notice: null, voice_model: null,
  }));
  // current_user_access:解锁模型选择器/cowork/projects 等入口(FeatureAccess{feature 自由串, status 枚举};解锁一律 "available")
  const FEATURE_FLAGS = ['model_picker', 'cowork', 'mobile_cowork_tab_enabled', 'projects', 'research', 'raven', 'artifacts_enabled']
    .map((feature) => ({ feature, status: 'available' }));
  const CURRENT_USER_ACCESS = { features: FEATURE_FLAGS, account_features: FEATURE_FLAGS, organization_permissions: null };
  // model_selector_state:默认 + 用户 PATCH 后的持久化(按 surface);org_enforced_default_model 永远 null,否则锁死用户没法切
  const defaultModelState = (surface) => ({
    id: surface, model: 'claude-opus-4-8', thinking: { effort: 'medium' },
    thinking_by_model: [], org_enforced_default_model: null, extra_option: null,
  });
  // GET /api/bootstrap/{orgId}/app_start —— 登录后主界面初始化(逆向 AppStartResponse)
  // account 必填;current_user_access 解锁入口;model_selector_state 反映用户在 UI 的选择(PATCH 落库)
  function appStart(res, account) {
    sendJson(res, {
      account: accountToApp(account),
      current_user_access: CURRENT_USER_ACCESS, org_growthbook: null,
      server_localizations: {}, personalized_greeting: [],
      model_selector_config: [{ id: 'chat', models: MODEL_ENTRIES }],
      model_selector_state: [modelStateStore.get('chat') || defaultModelState('chat')],
    });
  }
  // PATCH /api/organizations/{org}/model_selector_state/{surface} —— 用户选模型/thinking 的写回(不实现则选择不落库=切不动)
  async function modelSelectorState(req, res, surface) {
    const raw = (await readBody(req)) || '{}';
    log(`[model-state] PATCH surface=${surface} <- ${raw.slice(0, 400)}`); // 留痕 raw body 确认外层包裹
    let body = {}; try { body = JSON.parse(raw); } catch { }
    // 外层包裹不确定:直接 state 条目 / {state} / {model_selector_state:[]|{}} 都兜住
    let entry = null;
    if (body && typeof body === 'object') {
      if (body.model || body.thinking) entry = body;
      else if (body.state && typeof body.state === 'object') entry = body.state;
      else if (Array.isArray(body.model_selector_state)) entry = body.model_selector_state.find((e) => e && e.id === surface) || body.model_selector_state[0];
      else if (body.model_selector_state && typeof body.model_selector_state === 'object') entry = body.model_selector_state;
    }
    const prev = modelStateStore.get(surface) || defaultModelState(surface);
    const next = {
      id: surface,
      model: (entry && entry.model) || prev.model,
      thinking: (entry && entry.thinking) || prev.thinking,
      thinking_by_model: (entry && entry.thinking_by_model) ?? prev.thinking_by_model ?? [],
      org_enforced_default_model: null, // ⚠ 永不强制
      extra_option: (entry && entry.extra_option) ?? prev.extra_option ?? null,
    };
    modelStateStore.set(surface, next);
    log(`[model-state] surface=${surface} -> model=${next.model} thinking=${JSON.stringify(next.thinking)}`);
    sendJson(res, next);
  }

  // ── App 登录流程(逆向自 dex:com.anthropic.claude.api.login)────────
  // POST /api/auth/send_magic_link —— 真发 6 位验证码到邮箱(SMTP),回退到验证码输入框
  async function sendMagicLink(req, res) {
    let email = '';
    try { const b = JSON.parse((await readBody(req)) || '{}'); email = (b.email_address || b.email || b.contact?.email_address || '').trim(); } catch { }
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    const exp = Date.now() + 10 * 60 * 1000;
    if (email) otpStore.set(email.toLowerCase(), { code, exp, tries: 0 });
    log(`[login] send_magic_link email=${email || '(空)'} code=${code}`);
    if (email && mailer.enabled()) {
      mailer.sendMail({ to: email, subject: 'cc-cloud 登录验证码', text: `你的 cc-cloud 登录验证码:${code}\n\n10 分钟内有效。如非本人操作请忽略。` })
        .then((id) => log(`[login] 验证码邮件已发 ${email} id=${id}`))
        .catch((e) => log(`[login] 验证码邮件发送失败 ${email}: ${e.message}`));
    } else if (!mailer.enabled()) {
      log('[login] ⚠ SMTP 未配置,验证码仅见于日志');
    }
    // 不在这里做封禁检查:避免验证码环节就暴露"这个邮箱是否被封"的侧信道,后果统一留到 verifyLogin 处理。
    sendJson(res, {
      sent: true, sso_url: null, magic_link_intent_available: false,
      fallback_code_configuration: { charset: 'numeric', length: 6, show_input_after_delay: 0 },
    });
  }
  // POST /api/auth/verify_* —— 校验真验证码,命中才 find-or-create 账户并签发 secret
  async function verifyLogin(req, res) {
    let email = '', code = '', raw = '';
    try {
      raw = (await readBody(req)) || '{}';
      const b = JSON.parse(raw);
      const cred = b.credentials || {};                       // App 把 code/email 嵌在 credentials 里,不在顶层
      email = (b.email_address || b.email || cred.email_address || cred.email || '').trim().toLowerCase();
      code = String(b.code ?? b.verification_code ?? b.token ?? cred.code ?? cred.verification_code ?? cred.token ?? '').trim();
    } catch { }
    log(`[login] verify <- ${raw.slice(0, 300)}`);             // 留痕原始体,App 若改 shape 一眼可见
    // ★ 安全修复(多账号前提下必须):不再在 email 查无记录时回退比对"全局最近一次发出的验证码"——
    // 单账号时代那样做无害,多账号下会让 A 在凑巧的时机冒充登录到 B(B 刚请求的验证码被 A 顶替使用)。
    const rec = email ? otpStore.get(email) : null;
    const ok = !!(rec && Date.now() < rec.exp && code && code === rec.code);
    log(`[login] verify email=${email || '(空)'} code=${code || '(空)'} -> ${ok ? 'OK' : 'REJECT'}`);
    if (!ok) return sendJson(res, { success: false, error: { type: 'invalid_request_error', message: 'Invalid or expired verification code' } }, 400);
    otpStore.delete(email);
    const { account, created } = ACCOUNTS.create({ email });
    // 登录阶段也直接拦截被封账号(不是只指望 app_start 兜底)——协议契约只实锤验证了 app_start 这条链路,
    // 这里响应形状是自定义 {success,error} 包装不保证触发专门 UI,但服务端在此拒绝下发 cookie/secret
    // 才是真正的安全边界,不能让被封账号先拿到一个"看似有效"的会话。
    if (account.banned) return sendAccountBanned(res, account);
    lastActiveAccountUuid = account.uuid;
    const appAccount = accountToApp(account);
    const secret = 'cccloud_' + account.org_uuid.replace(/-/g, '');
    // claude.ai 鉴权是 sessionKey cookie(逆向自 w95:SharedPreferences user_cookies_*),
    // 登录处理器(m3b)不读 secret,会话全靠 Set-Cookie。不下发 -> App 无会话 -> 登录后弹回登录页。
    // host 已патч成 127.0.0.1(SNI 空),故 cookie 用 host-only(不带 Domain)。
    const cookies = [
      `sessionKey=sk-ant-sid01-cccloud-${account.org_uuid.replace(/-/g, '')}; Path=/; Max-Age=31536000; Secure; HttpOnly`,
      `lastActiveOrg=${account.org_uuid}; Path=/; Max-Age=31536000; Secure`,
    ];
    sendJson(res, {
      success: true, account: appAccount, secret,
      sso_url: null, created,
      // sealed AuthenticationState:@JsonClassDiscriminator("kind"),子类型 serialName 小写 "authenticated"
      state: { kind: 'authenticated', account: appAccount },
    }, 200, { 'set-cookie': cookies });
  }

  // ── 推理反代:第三方端点 ───────────────────────────────────────────
  async function infer(req, res, url) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const up = new URL(url.pathname + url.search, upstream);

    // 客户端侧的 token 被 AF() 清掉了,这里补回第三方的凭据
    const h = { ...upstreamHeaders, host: up.host };
    if (upstreamToken) h.authorization = upstreamToken;
    if (req.headers['anthropic-version']) h['anthropic-version'] = req.headers['anthropic-version'];
    if (req.headers['anthropic-beta']) h['anthropic-beta'] = req.headers['anthropic-beta'];
    if (req.headers['anthropic-dangerous-direct-browser-access']) {
      h['anthropic-dangerous-direct-browser-access'] = req.headers['anthropic-dangerous-direct-browser-access'];
    }
    h['accept-encoding'] = 'identity';

    log(`[infer] ${req.method} ${up.pathname} (${body.length}B) -> ${upstream}`);
    const r = await fetch(up, {
      method: req.method, headers: h,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    }).catch((e) => { log(`[infer] 上游错误 ${e.message}`); return null; });
    if (!r) { res.writeHead(502, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream unreachable' } })); }

    // fetch 会自动解压,上游的 content-encoding/length 必须丢掉,否则客户端再解一次 → ZlibError
    const out = {};
    r.headers.forEach((v, k) => {
      if (/^(content-encoding|content-length|transfer-encoding)$/i.test(k)) return;
      out[k] = v;
    });
    if (!out['content-type'] && !out['Content-Type']) out['content-type'] = 'application/json';
    const buf = Buffer.from(await r.arrayBuffer());
    out['content-length'] = String(buf.length);
    res.writeHead(r.status, out);
    res.end(buf);
  }

  // ── App 聊天:消费版 claude.ai API(建会话 + completion SSE)──────────
  // 契约逆向自 dex:ChatConversation / ChatCompletionRequest / messages.StreamEvent
  // 消费版有状态对话,上游 /v1/messages 无状态:首轮单条 user 可通,多轮历史待存储
  async function createConversation(req, res) {
    let b = {}; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { }
    const id = b.uuid || crypto.randomUUID();
    const e = convEnsure(id, { name: b.name || '', summary: b.summary || '', model: b.model ?? null, project_uuid: b.project_uuid ?? null, is_temporary: typeof b.is_temporary === 'boolean' ? b.is_temporary : false });
    if (b.name) e.name = b.name;
    if (b.model) e.model = b.model;
    e.updated_at = nowISO();
    saveConv();
    log(`[chat] 建会话 uuid=${id} model=${e.model || '-'} name=${(e.name || '').slice(0, 40)}`);
    sendJson(res, convMeta(e));
  }

  // POST /api/organizations/{org}/chat_conversations/{conv}/completion —— SSE 推理
  // 消费版 ChatCompletionRequest{prompt,model,parent_message_uuid,...}
  // → 上游 Anthropic /v1/messages(stream) → 再编码回消费版 StreamEvent SSE
  async function chatCompletion(req, res, convId, action = 'completion', account) {
    const raw = (await readBody(req)) || '{}';
    let cr = {}; try { cr = JSON.parse(raw); } catch { }
    const model = cr.model || 'claude-opus-4-8';
    const prompt = typeof cr.prompt === 'string' ? cr.prompt : '';
    // 建会话时继承 create_conversation_params(CreateChatRequest):项目内开聊必须挂上 project_uuid,
    // 否则 projects/{id}/conversations 过滤为空 → 项目会话列表恒空(App 表现为"新建会话不记录")
    const ccp = cr.create_conversation_params || {};
    const conv = convEnsure(convId, {
      project_uuid: ccp.project_uuid ?? cr.project_uuid ?? null,
      name: ccp.name || '', summary: ccp.summary || '', model: ccp.model ?? null,
      is_temporary: typeof ccp.is_temporary === 'boolean' ? ccp.is_temporary : false,
    });
    const hist = conv.messages;
    // uuid 链:App(26100920+)预分配本回合 TurnMessageUuids;message_start.message.uuid 必须==assistant_message_uuid
    const tmu = cr.turn_message_uuids || {};
    const userUuid = tmu.human_message_uuid || crypto.randomUUID();
    const asstUuid = tmu.assistant_message_uuid || crypto.randomUUID();
    // 重试(retry_completion/2):App 不带 prompt,要对"已存在的最后一条 user 消息"重答(早前 bug:当作新轮推空 prompt→模型答"你的消息是空的",还污染历史)
    const isRetry = /retry/.test(action) || !prompt;
    let baseHist, turnUserUuid;         // baseHist=发给上游的消息(到本轮 user 为止);turnUserUuid=本轮 user 消息 uuid(=助手 parent)
    if (isRetry) {
      const pUuid = cr.parent_message_uuid;
      let idx = pUuid ? hist.findIndex((m) => m.uuid === pUuid) : -1;
      if (idx < 0) for (let k = hist.length - 1; k >= 0; k--) if (hist[k].role === 'user') { idx = k; break; }
      baseHist = idx >= 0 ? hist.slice(0, idx + 1) : hist.slice();   // 丢弃该 user 之后失败/旧的 assistant
      turnUserUuid = baseHist.length ? baseHist[baseHist.length - 1].uuid : userUuid;
    } else {
      // 新一轮:先把 user 消息落库(即便上游失败也不丢→重试有据;真后端也是先存人类消息再生成)
      const parentUuid = cr.parent_message_uuid || (hist.length ? hist[hist.length - 1].uuid : null);
      // 本轮上传文件/附件挂到 user 消息并落库:cr.files=裸 file_uuid 数组(上传返回的 MessageFile),cr.attachments=客户端抽取内容(extracted_content)
      const turnFiles = Array.isArray(cr.files) ? cr.files.filter((x) => typeof x === 'string') : [];
      const turnAtts = Array.isArray(cr.attachments) ? cr.attachments.map((a) => ({ name: (a && a.file_name) || '', text: (a && typeof a.extracted_content === 'string') ? a.extracted_content : '' })).filter((a) => a.text) : [];
      conv.messages = [...hist, { uuid: userUuid, parent_uuid: parentUuid, role: 'user', text: prompt, files: turnFiles, atts: turnAtts, stop_reason: null }];
      if (!conv.name && prompt) conv.name = prompt.slice(0, 40);
      conv.updated_at = nowISO(); saveConv();
      baseHist = conv.messages; turnUserUuid = userUuid;
    }
    log(`[chat] ${action} conv=${convId} model=${model} 历史${hist.length}条 retry=${isRetry} prompt=${prompt.slice(0, 60)}`);

    // 消费版有状态,上游 /v1/messages 无状态:把 baseHist(到本轮 user 为止)拼成完整 messages
    const upMessages = baseHist.map((m) => ({ role: m.role, content: buildUpContent(m) }));

    const up = new URL('/v1/messages', upstream);
    const h = { ...upstreamHeaders, host: up.host, 'content-type': 'application/json', accept: 'text/event-stream', 'accept-encoding': 'identity' };
    if (upstreamToken) h.authorization = upstreamToken;
    h['anthropic-version'] = req.headers['anthropic-version'] || '2023-06-01';
    // effort → 上游 thinking:仅 claude 系原生支持;non-claude 经 new-api 转换易报错,不加(UI 仍显示但不生效)
    const effort = typeof cr.effort === 'string' ? cr.effort : '';
    const budgetMap = { low: 2048, medium: 6144, high: 12288, max: 24576 };
    const useThink = effort && effort !== 'none' && /claude/i.test(model) && budgetMap[effort];
    const upReq = { model, max_tokens: useThink ? budgetMap[effort] + 8192 : 16384, stream: true, messages: upMessages };
    if (useThink) upReq.thinking = { type: 'enabled', budget_tokens: budgetMap[effort] };
    const upBody = JSON.stringify(upReq);

    const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { } };
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // message_start.message 是消费版 CompletionMessage{uuid,parent_uuid}(非 Anthropic Message);助手 parent 指向本轮 user
    send('message_start', { type: 'message_start', message: { uuid: asstUuid, parent_uuid: turnUserUuid } });

    const ac = new AbortController();
    activeCompletions.set(convId, ac);                        // 供 stop_response 中止
    const doFetch = (bodyStr) => fetch(up, { method: 'POST', headers: h, body: bodyStr, signal: ac.signal }).catch((e) => { log(`[chat] 上游错误 ${e.message}`); return null; });
    // 安全网:万一上游处理某张图/文档失败(异常图片、体积过大、文档类型不支持等),把这些块降级为文本占位重试一次,避免整条 completion 硬失败。
    // 注:实测本上游(new-api→Kiro→Claude)对**真实图片是支持的**(真机上传的正常图会被模型看到并描述);仅退化输入(如 1x1 透明像素)会 502。见记忆 cc-app-file-upload-preview。
    const hasRich = upMessages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image' || b.type === 'document'));
    let r = await doFetch(upBody);
    if ((!r || !r.ok || !r.body) && hasRich && !ac.signal.aborted) {
      let eb = ''; try { if (r) eb = await r.text(); } catch { }
      log(`[chat] 富内容上游失败 status=${r ? r.status : '-'} ${eb.slice(0, 100)} → 降级文本重试`);
      const degMsgs = upMessages.map((m) => ({ role: m.role, content: Array.isArray(m.content) ? m.content.map((b) => b.type === 'image' ? { type: 'text', text: '[用户上传了一张图片,但本次未能处理,已跳过图片内容]' } : b.type === 'document' ? { type: 'text', text: '[用户上传了一个文档,但本次未能处理,已跳过文档内容]' } : b) : m.content }));
      r = await doFetch(JSON.stringify({ ...upReq, messages: degMsgs }));
    }
    if (!r || !r.ok || !r.body) {
      let eb = ''; try { if (r) eb = await r.text(); } catch { }
      log(`[chat] 上游失败/中止 status=${r ? r.status : '-'} aborted=${ac.signal.aborted}${eb ? ' body=' + eb.slice(0, 300) : ''}`);
      if (ac.signal.aborted) send('message_stop', { type: 'message_stop' }); // 用户点停,优雅收尾
      else send('error', { type: 'error', error: { type: 'api_error', message: 'upstream error' } });
      activeCompletions.delete(convId);
      return res.end();
    }
    // 上游 Anthropic SSE → 消费版 StreamEvent:块事件基本同构,仅补 stop_timestamp、规整 message_delta
    let sseBuf = '', stopReason = 'end_turn', asstText = '', sentDelta = false;
    try {
      for await (const chunk of r.body) {
        sseBuf += Buffer.from(chunk).toString('utf8');
        let i;
        while ((i = sseBuf.indexOf('\n\n')) >= 0) {
          const block = sseBuf.slice(0, i); sseBuf = sseBuf.slice(i + 2);
          const dl = block.split('\n').find((l) => l.startsWith('data:'));
          if (!dl) continue;
          const pl = dl.slice(5).trim();
          if (!pl || pl === '[DONE]') continue;
          let ev; try { ev = JSON.parse(pl); } catch { continue; }
          if (ev.type === 'content_block_start') send('content_block_start', { type: 'content_block_start', index: ev.index, content_block: ev.content_block });
          else if (ev.type === 'content_block_delta') {
            if (ev.delta && ev.delta.type === 'text_delta' && typeof ev.delta.text === 'string') asstText += ev.delta.text;
            send('content_block_delta', { type: 'content_block_delta', index: ev.index, delta: ev.delta });
          }
          else if (ev.type === 'content_block_stop') send('content_block_stop', { type: 'content_block_stop', index: ev.index, stop_timestamp: new Date().toISOString() });
          else if (ev.type === 'message_delta') { if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason; sentDelta = true; send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: (ev.delta && ev.delta.stop_sequence) ?? null } }); }
        }
      }
    } catch (e) { log(`[chat] 流中断 ${e.message}`); }
    // 必发终局 message_delta(带 stop_reason):上游未发时也补,保证 App 把本条标记为"已完成"(否则 App 持续轮询单会话等生成→超时→"无法完整生成")
    if (!sentDelta) send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null } });
    send('message_stop', { type: 'message_stop' });
    res.end();
    activeCompletions.delete(convId);                         // 流结束,解除中止登记
    // 落库:baseHist(已含本轮 user)+ assistant 进会话链;assistant 带 stop_reason=已完成(停止/中断也保留已生成部分)
    conv.messages = [...baseHist,
      { uuid: asstUuid, parent_uuid: turnUserUuid, role: 'assistant', text: asstText, stop_reason: stopReason },
    ];
    conv.updated_at = nowISO();
    conv.current_leaf_message_uuid = asstUuid;
    if (!conv.name && prompt) conv.name = prompt.slice(0, 40); // 列表显示用,首条 user 兜底
    if (!conv.model) conv.model = model;
    saveConv();
    log(`[chat] ${action} 完成 conv=${convId} stop=${stopReason} 回复${asstText.length}字 链${conv.messages.length}条`);
    pushCompletion(convId, asstText, account).catch((e) => log(`[fcm] 推送异常 ${e.message}`)); // 异步推送,不阻塞
  }

  // ── 请求身份解析:复用 org-id 路径段,不新增 Cookie/Header 校验机制 ──────
  // App 登录后把专属 org_uuid 记在 bootstrap 响应里,后续所有 /api/organizations/{org}/... 请求会
  // 原样带回这个值——下面 3 条正则覆盖现状里所有带 org/account 路径段的端点,照原样匹配,只是多一次提取。
  function extractOrgId(pathname) {
    let m = pathname.match(/^\/api\/organizations\/([^/]+)(?:\/|$)/); if (m) return m[1];
    m = pathname.match(/^\/api\/bootstrap\/([^/]+)\/app_start$/);     if (m) return m[1];
    m = pathname.match(/^\/api\/([^/]+)\/upload$/);                   if (m) return m[1];
    return null;
  }
  // 无 org 路径段的端点:靠连接级 stash + 全局 lastActiveAccountUuid 兜底指针解析账号(见该变量声明处注释)。
  const ORPHAN_ACCOUNT_PATHS = new Set([
    '/api/account', '/api/account/profile', '/api/bootstrap',
    '/api/oauth/profile', '/v1/oauth/token', '/api/oauth/validate',
  ]);
  // 协议实锤(反编译三次核实,这次精确追踪了 eg7.a→okg.p→ul0.B 全程寄存器映射,此前两版都错):
  // 1) 必须有 error 包裹(Lvz10.error:Lf6s,缺了解析成 null 走通用 ServerError 兜底)——第一版漏了这个,已修。
  // 2) 真正反直觉的一点:Lul0.B 内部用来匹配 wf7 细分原因表(13 值,含 account_banned=wf7.z)的字符串,
  //    来自 okg.p 的 p2 参数 = Lf6s.b = JSON 的 "message" 字段,不是 Lf6s.a("type" 字段)!
  //    type 字段只负责粗分类跳到 AuthError 这个大类(直接给 Lyf7 认识的 "permission_error" 最稳妥,
  //    不依赖 httpCode fallback);真正的 "account_banned" 必须放在 message 里。第二版把两者放反了。
  //    (交叉验证:eg7.a 里 details 存在/不存在两条分支各自独立推导出同一个参数映射,互相印证无误。)
  // 代价:account.banned_reason(自定义封禁理由)目前协议下传不到 App 侧 UI——wf7 匹配消耗了 message
  // 这个槽位,且 derived-message 展示逻辑处理的是另一个恒定占位值,不读用户填的理由;admin 查看仍可见。
  function sendAccountBanned(res, account) {
    log(`[ban] 拦截请求 account=${account.uuid} email=${account.email}`);
    const body = JSON.stringify({ type: 'error', error: { type: 'permission_error', message: 'account_banned' } });
    res.writeHead(403, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  }

  // ── 统一入口 ──────────────────────────────────────────────────────
  // base:写回 /bridge 响应的 api_base_url(隧道模式给 http://localhost)
  async function handle(req, res, url, base, ctx = {}) {
    const p = url.pathname;
    if (p !== '/v1/b') log(`[req] ${req.method} ${p}`);

    // ★ 请求身份解析 + 封禁门禁(路由分发之前,覆盖后面所有分支)
    let account = null;
    const orgId = extractOrgId(p);
    if (orgId) {
      account = ACCOUNTS.findByOrgUuid(orgId);
      if (!account) { log(`[acct] 未知 org_uuid=${orgId}`); return sendJson(res, { type: 'not_found_error', message: 'organization not found' }, 404); }
    } else if (ORPHAN_ACCOUNT_PATHS.has(p)) {
      account = ACCOUNTS.findByUuid(req.socket._ccAccount || lastActiveAccountUuid);
    }
    if (account) { lastActiveAccountUuid = account.uuid; req.socket._ccAccount = account.uuid; }
    // 全局拦截(不是只拦 app_start):上游推理凭据全账号共享,只拦主界面刷新放行 completion 起不到封禁作用。
    if (account && account.banned) return sendAccountBanned(res, account);

    if (p.startsWith('/api/features/') || p.startsWith('/api/eval') || p.startsWith('/sub/')) {
      return growthbook(res, p);
    }
    if (p.startsWith('/v1/code/sessions')) {
      // 每次都留一行痕迹,排查挂起用
      log(`[rc] ${req.method} ${p}${url.search}`);
      if (await remote(req, res, url, base, ctx) !== false) return;
    }
    if (p.includes('policy') || p.includes('limits')) return policy(res, p);
    if (p === '/api/auth/trusted_devices' && req.method === 'POST') return trustedDevice(req, res);
    if (p === '/v1/oauth/token') return oauthToken(res, account);
    if (p === '/api/oauth/validate') return oauthValidate(res, account);
    // ── App(手机端)控制面:缺了会被 infer 反代第三方→fetch failed→卡登录;给桩 ──
    if (p.startsWith('/api/event_logging')) { res.writeHead(204); return res.end(); }
    if (p === '/api/oauth/profile') return oauthProfile(res, account);
    if (p === '/api/claude_cli/bootstrap') return appBootstrap(res);
    if (/^\/api\/oauth\/organizations\/[^/]+\/sync\//.test(p)) return sendJson(res, { status: 'not_connected', connected: false });
    if (p.startsWith('/mcp-registry/')) return sendJson(res, { servers: [] });
    if (p === '/api/frame/contract/latest') return sendJson(res, {});
    if ((p === '/api/frame/types' || p === '/api/frame/artifacts') && req.method === 'GET') return sendJson(res, []); // artifacts 面:裸数组(ArtifactTypeListing/artifact),{} 对象 shape 错;完整 artifacts(sandbox host)HOLD
    if (p.startsWith('/api/claude_code_') || p.startsWith('/api/claude_cli/')) return sendJson(res, { enabled: false });
    // ── App 手机端登录后控制面(逆向自 app.log 实际请求)──
    if (p === '/api/account/profile') return accountProfile(res, account);
    if (p === '/api/account' && req.method === 'GET') return sendJson(res, accountToApp(account)); // 高频轮询(×17),回登录那套 Account
    if (p === '/api/account' && req.method === 'PUT') { try { await readBody(req); } catch { } return sendJson(res, accountToApp(account)); } // 改账号 → 回完整 Account
    if (/^\/api\/bootstrap\/[^/]+\/app_start$/.test(p)) return appStart(res, account);
    {
      const ms = p.match(/^\/api\/organizations\/[^/]+\/model_selector_state\/([^/]+)$/);
      if (ms && req.method === 'PATCH') return modelSelectorState(req, res, ms[1]);
    }
    if (p === '/api/bootstrap') return bootstrap(res, account);
    if (p === '/api/legal') return legal(res);
    if (/^\/api\/organizations\/[^/]+$/.test(p) && req.method === 'GET') return organization(res, account);
    if (/^\/v1\/projects\/[^/]+\/settings$/.test(p)) return projectSettings(res);
    if (p === '/v1/b') { res.writeHead(204); return res.end(); }
    // ── App 登录:magic link 回退验证码 + verify 直接放行 ──
    if (p === '/api/auth/send_magic_link') return sendMagicLink(req, res);
    if (p === '/api/auth/verify_magic_link' || p === '/api/auth/verify_phone_code' || p === '/api/auth/verify_google_mobile') return verifyLogin(req, res);
    // ── App 聊天(消费版 claude.ai API:会话 + completion SSE)──
    if (/^\/api\/organizations\/[^/]+\/chat_conversations$/.test(p)) {
      if (req.method === 'POST') return createConversation(req, res);
      return sendJson(res, convList().map(convMeta));         // GET 会话列表,updated_at 倒序
    }
    // recents:GET organizations/{org}/recents 实际返回 RecentsSectionsResponse(h4r),
    // 不是 ProjectRecentsResponse!(逆向 n2r.a:用 h4r.serializer 解码。早前 ProjectRecentsResponse 形状
    // 恒触发 Paging LoadResult.Error="出错了。请重试。",连空 data 也崩,因缺必填 sections 字段。)
    // h4r:{ sections:List<RecentsSection>[必填], incomplete_surfaces:List<RecentSurface>, degraded_surfaces:List<RecentSurface> }
    // RecentsSection(b4r):{ id[必填str], title[必填str], data:List<RecentsRow>, next_cursor:str? }
    // RecentsRow(n3r)多态按顶层 type:"chat"→oy5(flattened)、"project"→lip、"cowork_session"/"code_session"→j3r/l3r、其它→Unknown丢弃。
    if (/^\/api\/organizations\/[^/]+\/recents$/.test(p) && req.method === 'GET') {
      const rows = convList().slice(0, 50).map((e) => ({ ...convMeta(e), type: 'chat' }));
      const sections = rows.length ? [{ id: 'recents-chat', title: '', data: rows, next_cursor: null }] : [];
      return sendJson(res, { sections, incomplete_surfaces: [], degraded_surfaces: [] });
    }
    // 批量删除会话 POST .../chat_conversations/delete_many(逆向 i97.d:请求 DeleteChatsRequest{conversation_uuids:[]},
    // 响应 DeleteChatsResponse{deleted:Set,failed:Set})。未实现→兜底 204→App 解析不出 d9c→"出错了。请重试。"
    if (/^\/api\/organizations\/[^/]+\/chat_conversations\/delete_many$/.test(p) && ['POST', 'DELETE', 'PUT', 'PATCH'].includes(req.method)) {
      let b = {}; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { }
      const uuids = Array.isArray(b.conversation_uuids) ? b.conversation_uuids : [];
      const deleted = [], failed = [];
      for (const u of uuids) {
        if (convStore.delete(u)) deleted.push(u); else failed.push(u);
      }
      saveConv();
      log(`[chat] delete_many 删除 ${deleted.length}/${uuids.length} 条`);
      return sendJson(res, { deleted, failed });
    }
    {
      const mc = p.match(/^\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/(completion|completion2|retry_completion|retry_completion2)$/);
      if (mc && req.method === 'POST') return chatCompletion(req, res, mc[1], mc[2], account);
    }
    // 停止生成 POST .../chat_conversations/{conv}/stop_response —— abort 上游 fetch,进行中的 completion 走到 message_stop
    {
      const sc = p.match(/^\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/stop_response$/);
      if (sc && req.method === 'POST') {
        try { await readBody(req); } catch { }
        const ac = activeCompletions.get(sc[1]);
        if (ac) { ac.abort(); log(`[chat] stop_response conv=${sc[1]} 中止上游`); } else log(`[chat] stop_response conv=${sc[1]} 无进行中任务`);
        activeCompletions.delete(sc[1]);
        return sendJson(res, {});
      }
    }
    // 打开单会话 GET → ChatConversationWithNestedMessage,灌 convStore 真实历史(uuid/created_at/updated_at/name/summary/settings 必填)
    {
      const gc = p.match(/^\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)$/);
      if (gc && req.method === 'DELETE') { // 单会话删除(i97 verb5=DELETE,响应 kotlin.Unit→204;未实现则走兜底空默认,App 单删无效)
        try { await readBody(req); } catch { }
        const existed = convStore.delete(gc[1]); if (existed) saveConv();
        log(`[chat] 删除单会话 ${gc[1]} ${existed ? 'ok' : '(不存在)'}`);
        res.writeHead(204); return res.end();
      }
      if (gc && req.method === 'GET') {
        const e = convStore.get(gc[1]);
        const hist = e ? e.messages : [];
        const meta = e ? convMeta(e) : { uuid: gc[1], name: '', summary: '', model: null, settings: {}, project_uuid: null, is_starred: false, is_temporary: false, created_at: nowISO(), updated_at: nowISO(), current_leaf_message_uuid: null };
        return sendJson(res, {
          ...meta,
          chat_messages: hist.map((m, i) => ({
            uuid: m.uuid, parent_message_uuid: m.parent_uuid ?? null, index: i,
            created_at: e ? e.created_at : meta.created_at, text: m.text,
            // 重开会话靠 content 内容块渲染气泡(text 仅预览/搜索,历史渲染不读)→ 缺 content 则历史空白(实证)。
            // content 元素=消费版多态 union,判别键 type;text 块仅 text 必填(逆向 ChatMessage/jh6→text块/vwx)
            content: [{ type: 'text', text: m.text, stop_timestamp: e ? e.updated_at : nowISO() }],
            sender: m.role === 'assistant' ? 'assistant' : 'human', attachments: [],
            // ⚠️assistant 必带 stop_reason=已完成,否则 App 认为"仍在后台生成"→持续轮询单会话等结果→超时→"无法完整生成"(逆向 ChatMessage.stop_reason/jh6)
            stop_reason: m.role === 'assistant' ? (m.stop_reason || 'end_turn') : null,
          })),
        });
      }
    }
    // 生成标题 POST .../title → {title}(必填);请求 {message_content, recent_titles[]}
    {
      const tc = p.match(/^\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/title$/);
      if (tc && req.method === 'POST') {
        let b = {}; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { }
        const t = (b.message_content || '').trim().replace(/\s+/g, ' ');
        return sendJson(res, { title: t ? t.slice(0, 40) : 'New chat' });
      }
    }
    // 外围列表 + 写操作:shares 裸 [](正确);projects_v2={data,pagination} / user_artifacts={artifacts:[]}(裸 [] 会崩)
    if (/^\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/shares$/.test(p) && req.method === 'GET') return sendJson(res, []);
    // ── 会话分享(a57 逆向):POST .../share 建快照→ChatSnapshotSummary;GET .../latest→ChatShareState;DELETE .../share/{snap}→204;GET org 级 /shares→列表 ──
    {
      const shP = p.match(/^\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/share$/);
      if (shP && req.method === 'POST') {
        try { await readBody(req); } catch { }           // 可选 body CreateChatSnapshotRequest{update_only},create/update 都这么处理
        const cid = shP[1]; const conv = convStore.get(cid); const now = nowISO();
        let s = snapByConv(cid);
        if (s) { s.updated_at = now; s.snap_n = conv ? conv.messages.length : s.snap_n; }
        else { s = { uuid: crypto.randomUUID(), snapshot_name: (conv && conv.name) || 'Shared conversation', created_at: now, updated_at: now, conversation_uuid: cid, project_uuid: (conv && conv.project_uuid) || null, visibility: 'public', snap_n: conv ? conv.messages.length : 0, creator: snapCreatorFrom(account) }; snapStore.set(s.uuid, s); }
        saveSnaps(); log(`[share] 分享 conv=${cid} snapshot=${s.uuid}`);
        return sendJson(res, snapSummary(s));            // HTTP200+合法 f67 → App 弹分享面板,链接={origin}/share/{uuid}
      }
      const shL = p.match(/^\/api\/organizations\/[^/]+\/chat_conversations\/([^/]+)\/latest$/);
      if (shL && req.method === 'GET') {                 // ChatShareState:snapshot/blocked_reason 两 key 必在、值可 null
        const conv = convStore.get(shL[1]); const s = snapByConv(shL[1]);
        if (s) { const upToDate = !conv || s.snap_n === conv.messages.length; return sendJson(res, { snapshot: { uuid: s.uuid, up_to_date: upToDate, visibility: s.visibility || 'public' }, blocked_reason: null }); }
        return sendJson(res, { snapshot: null, blocked_reason: null });
      }
      const shD = p.match(/^\/api\/organizations\/[^/]+\/share\/([^/]+)$/);
      if (shD && req.method === 'DELETE') {              // 取消分享 → Unit/204
        try { await readBody(req); } catch { }
        const existed = snapStore.delete(shD[1]); if (existed) saveSnaps();
        log(`[share] 取消分享 snapshot=${shD[1]} existed=${existed}`); res.writeHead(204); return res.end();
      }
    }
    // 分享页本体(t57 ChatSnapshot 逆向):打开 {origin}/share/{uuid} 时 App 拉这个取历史只读渲染;report=举报,consumer 侧无响应体要求,回空对象兜底即可
    {
      const snGet = p.match(/^\/api\/organizations\/[^/]+\/chat_snapshots\/([^/]+)$/);
      if (snGet && req.method === 'GET') {
        const s = snapStore.get(snGet[1]);
        if (!s) return sendJson(res, {}, 404);
        return sendJson(res, snapshotFull(s));
      }
      const snRep = p.match(/^\/api\/organizations\/[^/]+\/chat_snapshots\/[^/]+\/report$/);
      if (snRep && req.method === 'POST') {
        let b = {}; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { }
        log(`[share] 举报快照 ${p} category=${b && b.category}`);
        return sendJson(res, {});
      }
    }
    if (/^\/api\/organizations\/[^/]+\/shares$/.test(p) && req.method === 'GET') return sendJson(res, [...snapStore.values()].map(snapSummaryWithChat));
    if (/^\/api\/organizations\/[^/]+\/projects_v2$/.test(p) && req.method === 'GET') {
      const data = [...projectStore.values()].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
      return sendJson(res, { data, pagination: { has_more: false, limit: data.length, offset: 0, total: data.length } });
    }
    if (/^\/api\/organizations\/[^/]+\/user_artifacts$/.test(p) && req.method === 'GET') return sendJson(res, { artifacts: [] });
    // 建项目 POST .../projects → Project,落库(projectStore)供 projects_v2 列出 + 详情读回
    {
      const pc = p.match(/^\/api\/organizations\/[^/]+\/projects$/);
      if (pc && req.method === 'POST') {
        let b = {}; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { }
        const proj = projMake(crypto.randomUUID(), b);
        projectStore.set(proj.uuid, proj); saveProj();
        log(`[proj] 建项目 uuid=${proj.uuid} name=${proj.name}`);
        return sendJson(res, proj);
      }
    }
    // 项目详情页子端点(逆向 C:Project/ChatConversationWithProjectReference/ProjectDoc/ProjectKnowledgeStats)
    {
      const gp = p.match(/^\/api\/organizations\/[^/]+\/projects\/([^/]+)(?:\/detail)?$/); // /{id} 与 /{id}/detail(App 详情页实际打带 /detail 后缀)都返回同一 Project
      if (gp && req.method === 'GET') return sendJson(res, projectStore.get(gp[1]) || projMake(gp[1]));
      if (gp && req.method === 'PUT') {
        let b = {}; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { }
        const proj = projectStore.get(gp[1]) || projMake(gp[1]);
        if (b.name) proj.name = b.name;
        if (typeof b.is_private === 'boolean') proj.is_private = b.is_private;
        if ('description' in b) proj.description = b.description ?? null;
        proj.updated_at = nowISO(); projectStore.set(gp[1], proj); saveProj();
        return sendJson(res, proj);
      }
      const pcv = p.match(/^\/api\/organizations\/[^/]+\/projects\/([^/]+)\/conversations(?:_v2)?$/);
      if (pcv && req.method === 'GET') {
        const proj = projectStore.get(pcv[1]);
        return sendJson(res, convList().filter((e) => e.project_uuid === pcv[1]).map((e) => ({ ...convMeta(e), project: proj ? { uuid: proj.uuid, name: proj.name } : null })));
      }
      const pdoc = p.match(/^\/api\/organizations\/[^/]+\/projects\/([^/]+)\/docs$/);
      if (pdoc && req.method === 'GET') return sendJson(res, []);
      if (pdoc && req.method === 'POST') { let b = {}; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { } return sendJson(res, { uuid: crypto.randomUUID(), file_name: b.file_name || 'doc', created_at: nowISO(), project_uuid: pdoc[1], content: b.content ?? null }); }
      if (/^\/api\/organizations\/[^/]+\/projects\/[^/]+\/kb\/stats$/.test(p) && req.method === 'GET') return sendJson(res, { knowledge_size: 0, max_knowledge_size: 104857600, project_knowledge_search_threshold: 0.0, use_project_knowledge_search: false });
      if (/^\/api\/organizations\/[^/]+\/projects\/[^/]+\/kb\/resync$/.test(p) && req.method === 'POST') { try { await readBody(req); } catch { } res.writeHead(204); return res.end(); }
    }
    // 文件上传 POST /api/{org}/upload(单段,不带 organizations)→ multipart,单 part 名恒为 "file"。存字节+元数据,回对应 MessageFile 变体。
    if (/^\/api\/[^/]+\/upload$/.test(p) && req.method === 'POST') {
      let buf; try { buf = await readBodyBuffer(req); } catch { buf = Buffer.alloc(0); }
      const parts = parseMultipart(buf, req.headers['content-type']);
      const fp = parts.find((x) => /name="?file"?/i.test(x.headers)) || parts[0];
      if (!fp || !fp.body || fp.body.length === 0) { log('[file] 上传无有效 part'); return sendJson(res, messageFileResp({ file_uuid: crypto.randomUUID(), file_name: 'upload', mime: 'application/octet-stream', size_bytes: 0, created_at: nowISO() }, account)); }
      const fn = (/filename="([^"]*)"/i.exec(fp.headers) || [])[1] || 'upload';
      const mime = ((/content-type:\s*([^\r\n;]+)/i.exec(fp.headers) || [])[1] || 'application/octet-stream').trim();
      const uuid = crypto.randomUUID(); // 裸 36 位,App 走 UUID.fromString,带前缀/截断会崩
      try { fs.mkdirSync(FILES_DIR, { recursive: true }); fs.writeFileSync(fileBytesPath(uuid), fp.body); } catch (e) { log(`[file] 落盘失败 ${e.message}`); }
      const meta = { file_uuid: uuid, file_name: fn, mime, size_bytes: fp.body.length, created_at: nowISO() };
      fileStore.set(uuid, meta); saveFiles();
      log(`[file] 上传 ${fn} ${mime} ${fp.body.length}B uuid=${uuid}`);
      return sendJson(res, messageFileResp(meta, account));
    }
    // 文件字节服务(预览/下载):preview/thumbnail/document asset url 都指到这里;按存储 MIME 回,图片必须 image/*(绝不能 text/html)
    const fc = p.match(/^\/api\/organizations\/[^/]+\/files\/([^/]+)\/contents$/);
    if (fc && req.method === 'GET') {
      const meta = fileStore.get(fc[1]);
      let buf = null; try { buf = meta ? fs.readFileSync(fileBytesPath(fc[1])) : null; } catch { buf = null; }
      if (!buf) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}'); }
      const ct = meta.mime && !/html/i.test(meta.mime) ? meta.mime : 'application/octet-stream';
      res.writeHead(200, { 'content-type': ct, 'content-length': buf.length, 'cache-control': 'private, max-age=86400' });
      return res.end(buf);
    }
    // chat_conversations/{id}/serving:连接器/MCP 元数据,与文件无关;空列表=正确 no-op(否则 App 解析不出 ChatServing)
    if (/^\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/serving$/.test(p) && req.method === 'GET') return sendJson(res, { connector_domains_withheld: [] });
    // D(cowork):experiences surface —— experiences 必填(裸 {} 兜底会崩);action/track 写操作占位;cowork_settings 三字段全可选
    if (/^\/api\/organizations\/[^/]+\/experiences$/.test(p) && req.method === 'GET') return sendJson(res, { experiences: [] });
    if (/^\/api\/organizations\/[^/]+\/experiences\/(?:action|track)$/.test(p) && req.method === 'POST') { try { await readBody(req); } catch { } res.writeHead(204); return res.end(); }
    if (/^\/api\/organizations\/[^/]+\/cowork_settings$/.test(p) && req.method === 'GET') return sendJson(res, { auto_mode_enabled: false, skip_approvals_enabled: false });
    // memory/settings:6 字段全可选({} 本不崩),补真实默认让记忆设置页开关态正确(MemorySettingsResponse);其余 mcp/v2/bootstrap、notification/channels 维持兜底 HOLD
    if (/^\/api\/organizations\/[^/]+\/memory\/settings$/.test(p) && req.method === 'GET') return sendJson(res, { classic_mode_available: true, enabled_melange: false, enabled_saffron: false, enabled_saffron_search: false, memory_mode: 'off', sensitive_consent_recorded: false });

    // 通知(逆向 wnq.x=GET channels→List<msm>;hsm.a=GET preferences(verb1)/hsm.b=PATCH(verb4)→vum)
    // ⚠️枚举序列名大写:channel_type "FCM"/"APNS"(qsm)、status "ACTIVE"/"INACTIVE"(osm);时间走 i5i=Iso8601Instant 字符串
    // ⚠️GET channels 必须回裸数组 List<msm>——兜底 {} 会解析失败→"开启通知…出了点问题"
    {
      const nchan = (b = {}) => ({
        channel_type: (b.channel_type || 'FCM'), client_app_name: b.client_app_name || 'Claude',
        client_platform: b.client_platform || 'android', device_id: b.device_id || crypto.randomUUID(),
        last_successful_delivery_time: null, last_token_refresh_time: nowISO(),
        registration_token: b.registration_token || '', status: 'ACTIVE', uuid: b.uuid || crypto.randomUUID(),
      });
      const mch = p.match(/^\/api\/organizations\/[^/]+\/notification\/channels(?:\/([^/]+))?$/);
      if (mch) {
        if (req.method === 'GET') return sendJson(res, [...chanStore.values()]); // 列出已注册通道(裸 List<msm>)
        if (req.method === 'POST') {
          let b = {}; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { }
          const ch = nchan(b);
          if (ch.registration_token) { chanStore.set(ch.registration_token, ch); saveChan(); } // 按 token 去重落库,供 completion 推送
          log(`[notif] 注册推送通道 token=…${(ch.registration_token || '').slice(-8)} 共${chanStore.size}个`);
          return sendJson(res, ch);
        }
        if (req.method === 'DELETE') {
          try { await readBody(req); } catch { }
          if (mch[1]) { for (const [t, c] of [...chanStore]) if (c.uuid === mch[1]) { chanStore.delete(t); } saveChan(); }
          res.writeHead(204); return res.end();
        }
      }
      if (/^\/api\/organizations\/[^/]+\/notification\/preferences$/.test(p)) {
        if (req.method === 'GET') return sendJson(res, notifResp());
        if (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST') {
          let b = {}; try { b = JSON.parse((await readBody(req)) || '{}'); } catch { }
          const fp = (b && b.preferences && typeof b.preferences.feature_preference === 'object' && b.preferences.feature_preference) || {};
          for (const [k, v] of Object.entries(fp)) { // 逐 feature 合并(App 每次 PATCH 可能只带被改的那个)
            if (v && typeof v === 'object') notifFP[k] = { ...(notifFP[k] || {}), ...v };
          }
          saveNotif(); log('[notif] 更新通知偏好'); return sendJson(res, notifResp());
        }
      }
      if (/^\/api\/organizations\/[^/]+\/notification\/push\/track_open$/.test(p) && req.method === 'POST') { try { await readBody(req); } catch { } res.writeHead(204); return res.end(); }
    }

    // 分享链接本体:{origin}/share/{uuid},浏览器/App 直接打开用的页面,不带 /api 前缀 → 必须排在下方 infer 兜底之前,
    // 否则被当成推理请求转发上游 404(2026-10-15 实证:curl 直连确认了这条路径真会被最终 else 分支吃掉)。
    {
      const shPage = p.match(/^\/share\/([^/]+)\/?$/);
      if (shPage && req.method === 'GET') {
        const s = snapStore.get(shPage[1]);
        if (!s) { log(`[share] 打开分享页 ${shPage[1]} 不存在`); return sendHtml(res, shareNotFoundHtml(), 404); }
        log(`[share] 打开分享页 snapshot=${shPage[1]}`);
        return sendHtml(res, sharePageHtml(snapshotFull(s)));
      }
    }

    // 推理面 → 第三方;其它控制面未实现 → 空默认(别让 App 因控制面 fetch failed 卡住),记日志供迭代
    if (/^\/v1\/(messages|complete|models)/.test(p)) return infer(req, res, url);
    if (p.startsWith('/api/') || p.startsWith('/v1/') || p.startsWith('/mcp')) {
      log(`[api] 未实现 ${req.method} ${p} -> 空默认`);
      if (req.method === 'GET') return sendJson(res, {});
      res.writeHead(204); return res.end();
    }
    return infer(req, res, url);
  }

  return { RC, handle, readBody };
}