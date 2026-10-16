import { useState } from 'react';
import { api, setToken } from '../api.js';

// 登录/注册表单,原样移植现有 web/index.html 的 #login 文案与交互(用户名+密码、
// 登录/注册两个按钮、错误提示行)。成功后把 token 存 localStorage、把 user 回调给父层。
export default function Login({ onAuthed }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');

  async function doAuth(kind) {
    setErr('');
    try {
      const j = await api(`/auth/${kind}`, { method: 'POST', body: JSON.stringify({ username, password }) });
      setToken(j.token);
      onAuthed(j.user);
    } catch (e) {
      setErr(e.message);
    }
  }

  return (
    <div className="mx-auto mt-[10vh] max-w-[360px] rounded-2xl border border-border bg-surface p-7">
      <h1 className="text-xl font-semibold">Claude Cloud CE</h1>
      <p className="mb-5 mt-1 text-sm text-muted">自部署 Claude 远程会话控制台</p>
      <div className="flex flex-col gap-2.5">
        <input
          className="rounded-lg border border-border bg-transparent px-3 py-2.5 outline-none focus:border-accent"
          placeholder="用户名" autoComplete="username"
          value={username} onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="rounded-lg border border-border bg-transparent px-3 py-2.5 outline-none focus:border-accent"
          placeholder="密码" type="password" autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      <div className="mt-2.5 flex gap-2.5">
        <button className="flex-1 rounded-lg bg-accent px-3.5 py-2 text-white" onClick={() => doAuth('login')}>登录</button>
        <button className="flex-1 rounded-lg border border-border px-3.5 py-2" onClick={() => doAuth('register')}>注册</button>
      </div>
      <div className="mt-2 min-h-[18px] text-sm text-red-500">{err}</div>
    </div>
  );
}
