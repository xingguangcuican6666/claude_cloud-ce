import { useEffect, useRef, useState } from 'react';
import { api, authHeaders } from '../api.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 从 contentByIndex(Map<number, part>)按 key 升序取出 content 数组,外加必填的 id/role/status——
// 每条 ThreadMessageLike 都显式给 id,不依赖库按数组下标 fallback 生成的 id(复核确认的坑:不稳定)。
function draftToLike(draft, statusType) {
  const keys = [...draft.contentByIndex.keys()].sort((a, b) => a - b);
  return {
    id: draft.uuid,
    role: draft.role,
    status: { type: statusType },
    content: keys.map((k) => draft.contentByIndex.get(k)),
  };
}

// base64/url 两种 source 拼成 assistant-ui 认的 image part。⚠️有硬校验:必须 data:image/* 开头、
// 或 https://、或 blob: 开头,不合规会被库静默丢弃(只有 console.warn,UI 上完全看不出来)——
// 复核时读 thread-message-like.ts 源码确认的坑,这里保证一定给出合规格式。
function toImagePart(source) {
  if (source && source.type === 'base64' && source.media_type && source.data) {
    return { type: 'image', image: `data:${source.media_type};base64,${source.data}` };
  }
  if (source && source.type === 'url' && source.url) return { type: 'image', image: source.url };
  return { type: 'image', image: '' };
}

// 协议完整 content block(这条消息的全部事实已经到齐)-> ThreadMessageLike part 数组。
// tool_result 不在这里处理——它出现在后续一条独立的 user 消息里,见 patchToolResults。
function blocksToParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter((b) => b && b.type !== 'tool_result').map((b) => {
    switch (b.type) {
      case 'text': return { type: 'text', text: b.text || '' };
      case 'thinking': return { type: 'reasoning', text: b.thinking || '' };
      case 'redacted_thinking': return { type: 'reasoning', text: '[此处思考内容已被隐去]' };
      case 'tool_use': return { type: 'tool-call', toolCallId: b.id, toolName: b.name, args: b.input || {}, argsText: JSON.stringify(b.input ?? {}) };
      case 'image': return toImagePart(b.source);
      default: return { type: 'text', text: '' };
    }
  });
}

/**
 * 单个会话的消息状态桥接:订阅 /api/sessions/{id}/stream 的 SSE,把协议事件(重点是
 * user/assistant 完整消息 + stream_event 增量 + result 回合结束信号)累积成
 * ThreadMessageLike[],供 ChatPanel 喂给 useExternalStoreRuntime。
 * 设计细节见计划文档《Web 控制台改用 assistant-ui 组件库重做》"消息流桥接设计"一节。
 *
 * ⚠️调用方必须在切换会话时整体重新挂载这个 hook 所在的组件(父层 key={sessionId}),
 * 不是在同一个挂载实例里改 sessionId——这样每次都是全新的内部累积状态,不用处理
 * "原地切会话"这种更复杂的场景(对应计划"不碰 assistant-ui 多线程机制"的决定)。
 */
export function useSessionStore(sessionId) {
  const [messages, setMessages] = useState([]);
  const [isRunning, setIsRunning] = useState(false);
  const [sendError, setSendError] = useState(null);
  const [connectionError, setConnectionError] = useState(null); // 终态连接失败(401/404),停止重连

  // 本组件挂载实例专属的累积状态,plain ref——不需要跨 sessionId 复用(见上方注释)。
  const draftsRef = useRef(new Map());       // uuid -> { uuid, role, contentByIndex }
  const toolLocationRef = useRef(new Map()); // tool_use_id -> messageId(更早那条 assistant 消息)
  const openTurnUuidsRef = useRef(new Set());
  const lastIndexRef = useRef(-1);           // 重连游标:after = lastIndexRef.current + 1,不要永远 0

  useEffect(() => {
    if (!sessionId) return undefined;
    const ac = new AbortController();
    let cancelled = false;
    let backoff = 500;

    function handleEvent(ev) {
      if (!ev || typeof ev !== 'object') return;
      // 子代理/嵌套工具调用的流:有独立 uuid、parent_tool_use_id 非空。v1 不进顶层时间线,
      // 避免子代理内部碎碎念串进主对话(升级路径:ThreadMessageLike 的 tool-call part
      // 原生带 messages 字段,官方注释就是给"工具调用内嵌子对话"用的)。
      if (ev.parent_tool_use_id != null) return;
      switch (ev.type) {
        case 'user':
        case 'assistant':
          finalizeOrAppend(ev);
          break;
        case 'stream_event':
          applyStreamEvent(ev);
          break;
        case 'result':
          finalizeTurn();
          break;
        default:
          // system/control_*/tool_progress/tool_use_summary/conversation_reset/
          // composer_notice*/prompt_suggestion/rate_limit_event/sources_changed/
          // env_manager_log/command_lifecycle/message_delta —— 第一版不渲染,显式 no-op
          break;
      }
    }

    function applyStreamEvent(frame) {
      const uuid = frame.uuid;
      if (!uuid) return;
      const e = frame.event || {};
      let draft = draftsRef.current.get(uuid);
      if (!draft) {
        draft = { uuid, role: 'assistant', contentByIndex: new Map() };
        draftsRef.current.set(uuid, draft);
        openTurnUuidsRef.current.add(uuid);
        setIsRunning(true);
        setMessages((prev) => [...prev, draftToLike(draft, 'running')]);
      }
      if (e.type === 'content_block_start') {
        const b = e.content_block || {};
        if (b.type === 'text') draft.contentByIndex.set(e.index, { type: 'text', text: '' });
        else if (b.type === 'thinking') draft.contentByIndex.set(e.index, { type: 'reasoning', text: '' });
        else if (b.type === 'redacted_thinking') draft.contentByIndex.set(e.index, { type: 'reasoning', text: '[此处思考内容已被隐去]' });
        else if (b.type === 'tool_use') {
          draft.contentByIndex.set(e.index, { type: 'tool-call', toolCallId: b.id, toolName: b.name, argsText: '' });
          if (b.id) toolLocationRef.current.set(b.id, uuid);
        } else if (b.type === 'image') draft.contentByIndex.set(e.index, toImagePart(b.source));
      } else if (e.type === 'content_block_delta') {
        const part = draft.contentByIndex.get(e.index);
        if (!part) return;
        const d = e.delta || {};
        if (d.type === 'text_delta') part.text = (part.text || '') + (d.text || '');
        else if (d.type === 'thinking_delta') part.text = (part.text || '') + (d.thinking || '');
        else if (d.type === 'input_json_delta') part.argsText = (part.argsText || '') + (d.partial_json || '');
        // 不自己 JSON.parse argsText——assistant-ui 的 fromThreadMessageLike 只收到 argsText、
        // 不收到 args 时,会自动调内置 parsePartialJsonObject 做容错部分解析(复核确认的简化点)。
      }
      // message_delta(stop_reason/usage)、content_block_stop、message_stop 都不需要特殊处理
      setMessages((prev) => prev.map((m) => (m.id === uuid ? draftToLike(draft, 'running') : m)));
    }

    function finalizeOrAppend(ev) {
      const role = ev.message && ev.message.role === 'user' ? 'user' : 'assistant';
      const content = blocksToParts(ev.message && ev.message.content);
      const uuid = ev.uuid;
      if (role === 'user') {
        setMessages((prev) => [...prev, { id: uuid, role: 'user', content, status: { type: 'complete' } }]);
        patchToolResults(ev);
        return;
      }
      // 协议保证最终落地的完整 assistant 事件是权威真相,整体覆盖掉同 uuid 的草稿
      const complete = { id: uuid, role: 'assistant', content, status: { type: 'complete' } };
      const hadDraft = draftsRef.current.delete(uuid);
      openTurnUuidsRef.current.delete(uuid);
      setMessages((prev) => (hadDraft ? prev.map((m) => (m.id === uuid ? complete : m)) : [...prev, complete]));
      for (const part of content) {
        if (part.type === 'tool-call' && part.toolCallId) toolLocationRef.current.set(part.toolCallId, uuid);
      }
      if (openTurnUuidsRef.current.size === 0) setIsRunning(false);
    }

    // tool_result 出现在后续一条独立的 user 消息里,要回填进更早那条 assistant 消息对应的
    // tool-call part——immutable 替换那一条消息对象,其余消息保持引用不变(渲染优化)。
    function patchToolResults(userEvent) {
      const content = userEvent.message && userEvent.message.content;
      if (!Array.isArray(content)) return;
      for (const c of content) {
        if (!c || c.type !== 'tool_result') continue;
        const ownerId = toolLocationRef.current.get(c.tool_use_id);
        if (!ownerId) continue;
        setMessages((prev) => prev.map((m) => {
          if (m.id !== ownerId) return m;
          return {
            ...m,
            content: m.content.map((part) => (part.type === 'tool-call' && part.toolCallId === c.tool_use_id
              ? { ...part, result: c.content, isError: !!c.is_error }
              : part)),
          };
        }));
      }
    }

    // result = 协议定义的"回合结束信号"(反编译 claude.exe 协议文档字符串原话:
    // "treat it as the turn-complete signal"),是主力兜底,不是超时:不管草稿有没有
    // 等到干净的完整 assistant 事件覆盖,result 一来就强制收尾。
    function finalizeTurn() {
      for (const uuid of openTurnUuidsRef.current) {
        const draft = draftsRef.current.get(uuid);
        if (draft) {
          const done = draftToLike(draft, 'incomplete');
          setMessages((prev) => prev.map((m) => (m.id === uuid ? done : m)));
          draftsRef.current.delete(uuid);
        }
      }
      openTurnUuidsRef.current.clear();
      setIsRunning(false);
    }

    async function readFrames(res) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (!line) continue; // 跳过 "id: N" / ": open" / ": ping" 这些非 data 行
          let payload;
          try { payload = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (typeof payload.index !== 'number' || payload.index <= lastIndexRef.current) continue;
          lastIndexRef.current = payload.index;
          handleEvent(payload.event);
        }
      }
    }

    (async function loop() {
      while (!cancelled) {
        try {
          const after = lastIndexRef.current + 1;
          const res = await fetch(`/api/sessions/${sessionId}/stream?after=${after}`, {
            headers: authHeaders(),
            signal: ac.signal,
          });
          if (res.status === 401 || res.status === 404) {
            // 终态失败(token 过期 / 会话不存在或已被归档)——重试也不会自己好,
            // 停下来给个明确提示,不要悄悄重连到天荒地老。
            setConnectionError(res.status === 401 ? '登录已过期,请刷新页面重新登录' : '此会话不存在或已失效');
            return;
          }
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          backoff = 500; // 连上就清退避计数
          await readFrames(res);
          if (cancelled) return;
          // 服务端正常关闭连接也当断线处理,重连而不是直接退出循环
        } catch {
          if (ac.signal.aborted) return; // 主动 abort(切会话/卸载)绝不重连,避免竞态
        }
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 8000);
      }
    })();

    return () => { cancelled = true; ac.abort(); };
  }, [sessionId]);

  async function onNew(appendMessage) {
    const parts = Array.isArray(appendMessage.content) ? appendMessage.content : [];
    const text = parts.filter((c) => c.type === 'text').map((c) => c.text).join('');
    if (!text.trim()) return;
    setSendError(null);
    try {
      await api(`/api/sessions/${sessionId}/prompt`, { method: 'POST', body: JSON.stringify({ text }) });
      setIsRunning(true); // 没有本地乐观消息气泡(见计划"净效果"一条),只提前亮"生成中"态
    } catch (e) {
      setSendError(e.message || String(e));
    }
  }

  return { messages, isRunning, sendError, connectionError, onNew };
}
