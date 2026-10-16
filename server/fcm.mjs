// FCM HTTP v1 推送:服务账号私钥签 JWT → 换 OAuth2 access_token → POST messages:send
// 用于自部署后端给手机发"对话完成"等推送。服务账号 JSON 由调用方给路径,私钥只在本进程内用,绝不外传。
import crypto from 'node:crypto';
import fs from 'node:fs';

const b64url = (buf) => (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64url');

export function createFcm({ serviceAccountPath, log }) {
  let sa = null;
  try { sa = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8')); }
  catch (e) { log?.(`[fcm] 服务账号未加载(${e.code || e.message}),推送禁用`); }
  const enabled = !!(sa && sa.private_key && sa.client_email && sa.project_id);
  if (enabled) log?.(`[fcm] 推送就绪 project=${sa.project_id}`);

  let tok = null, tokExp = 0;
  async function accessToken() {
    const now = Math.floor(Date.now() / 1000);
    if (tok && now < tokExp - 60) return tok;
    const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claim = b64url(JSON.stringify({
      iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    }));
    const input = `${head}.${claim}`;
    const sig = b64url(crypto.sign('RSA-SHA256', Buffer.from(input), sa.private_key));
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${input}.${sig}` }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.access_token) throw new Error(`oauth ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
    tok = j.access_token; tokExp = now + (j.expires_in || 3600);
    return tok;
  }

  // message:FCM v1 Message(需含 token)。返回 {ok, status, body}。单 token 失败不抛,交由调用方按返回处理(404/UNREGISTERED→删 token)。
  async function send(message) {
    if (!enabled) return { ok: false, status: 0, body: 'fcm disabled' };
    let at; try { at = await accessToken(); } catch (e) { log?.(`[fcm] 取 token 失败 ${e.message}`); return { ok: false, status: 0, body: String(e.message) }; }
    const r = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
      method: 'POST', headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const body = await r.text();
    return { ok: r.ok, status: r.status, body };
  }

  return { enabled, send, projectId: sa?.project_id || null };
}
