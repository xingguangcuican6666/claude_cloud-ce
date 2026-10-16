// fetch 封装 + token 存取——原样移植自 web/index.html 的 api()/authH()。
// 注意:/auth、/api 走的服务端 server/app.mjs 的 web() 函数,鉴权是 Authorization: Bearer <token>,
// 服务端完全没有 CORS 头(见计划文档),开发态靠 vite.config.js 的 server.proxy 转发到 :8890。

const TOKEN_KEY = 'cc_token';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...authHeaders(), ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { /* 非 JSON 响应(比如 404 html),保持 {} */ }
  if (!res.ok) throw new Error(json.error || String(res.status));
  return json;
}
