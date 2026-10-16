import { useEffect, useState } from 'react';
import { api } from '../api.js';

// 左侧会话列表:轮询 /api/sessions,原 4s 间隔不变。`events` 字段是数字(事件计数),
// 不是数组,只做徽标文案用(服务端契约见计划文档)。
export default function SessionList({ activeId, onSelect }) {
  const [sessions, setSessions] = useState(null); // null = 还没拉到过一次

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const j = await api('/api/sessions');
        if (!cancelled) setSessions(j.sessions || []);
      } catch { /* 静默重试,下一轮再拉 */ }
    }
    refresh();
    const t = setInterval(refresh, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  if (sessions === null) return null;
  if (sessions.length === 0) {
    return <div className="border-b border-border p-3 text-sm text-muted">暂无会话 — 接入一个 cc worker</div>;
  }

  return (
    <div className="overflow-y-auto">
      {sessions.map((s) => (
        <div
          key={s.id}
          onClick={() => onSelect(s.id)}
          className={`cursor-pointer border-b border-border p-3 hover:bg-surface ${s.id === activeId ? 'border-l-2 border-l-accent bg-surface' : ''}`}
        >
          <div className="truncate font-medium">{s.title || s.id}</div>
          <div className="mt-0.5 text-xs text-muted">{s.state} · {s.events} 事件</div>
        </div>
      ))}
    </div>
  );
}
