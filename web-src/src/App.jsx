import { useEffect, useState } from 'react';
import { api, getToken, setToken } from './api.js';
import Login from './components/Login.jsx';
import SessionList from './components/SessionList.jsx';
import ChatPanel from './components/ChatPanel.jsx';
import DeviceModal from './components/DeviceModal.jsx';

// 顶层状态流转,原样移植现有 web/index.html 的 boot()/enter() 逻辑:有 token 就先拿
// /auth/me 验一下,验不过就清掉重新走登录;没有 token 直接进登录页。
export default function App() {
  const [user, setUser] = useState(undefined); // undefined=还在验证中,null=未登录,对象=已登录
  const [activeId, setActiveId] = useState(null);
  const [listCollapsed, setListCollapsed] = useState(false);

  useEffect(() => {
    const token = getToken();
    if (!token) { setUser(null); return; }
    api('/auth/me').then((j) => setUser(j.user)).catch(() => { setToken(''); setUser(null); });
  }, []);

  function logout() {
    api('/auth/logout', { method: 'POST' }).catch(() => {});
    setToken('');
    location.reload();
  }

  function selectSession(id) {
    setActiveId(id);
    if (window.innerWidth < 768) setListCollapsed(true); // 和下面 md: 断点(768px)对齐,避免中间宽度行为不一致
  }

  if (user === undefined) return null; // 验证中,避免登录页一闪而过
  if (!user) return <Login onAuthed={setUser} />;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
        <button
          className="rounded-lg border border-border px-2 py-1 text-sm md:hidden"
          onClick={() => setListCollapsed((v) => !v)}
        >☰</button>
        <span className="font-semibold text-accent">Claude Cloud CE</span>
        <span className="flex-1" />
        <span className="text-sm text-muted">{user.username}</span>
        <DeviceModal />
        <button className="rounded-lg border border-border px-3 py-1.5 text-sm" onClick={logout}>登出</button>
      </header>
      <main className="flex min-h-0 flex-1">
        <div className={`w-[280px] shrink-0 border-r border-border bg-surface ${listCollapsed ? 'hidden' : ''} md:block`}>
          <SessionList activeId={activeId} onSelect={selectSession} />
        </div>
        <div className="min-w-0 flex-1">
          {activeId
            ? <ChatPanel key={activeId} sessionId={activeId} />
            : (
              <div className="flex h-full items-center justify-center p-5 text-center text-muted">
                选择左侧会话,或在某台机器上接入一个 cc worker(右上「+ cc 设备」)
              </div>
            )}
        </div>
      </main>
    </div>
  );
}
