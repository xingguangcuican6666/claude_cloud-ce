import { AssistantRuntimeProvider, useExternalStoreRuntime, ThreadPrimitive } from '@assistant-ui/react';
import { useSessionStore } from '../hooks/useSessionStore.js';
import UserBubble from './message-parts/UserBubble.jsx';
import AssistantBubble from './message-parts/AssistantBubble.jsx';
import Composer from './message-parts/Composer.jsx';

// 父层用 key={sessionId} 包这个组件,切换会话=整体重新挂载,拿到全新的
// useSessionStore 内部累积状态(不碰 assistant-ui 的多线程/thread-list 机制,见计划文档)。
export default function ChatPanel({ sessionId }) {
  const { messages, isRunning, sendError, connectionError, onNew } = useSessionStore(sessionId);
  const runtime = useExternalStoreRuntime({
    messages,
    isRunning,
    convertMessage: (m) => m, // messages 已经是 ThreadMessageLike 形状,原样透传
    onNew,
  });

  if (connectionError) {
    return <div className="flex h-full items-center justify-center p-5 text-center text-muted">{connectionError}</div>;
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="flex h-full flex-col">
        <ThreadPrimitive.Viewport className="flex-1 overflow-y-auto p-4">
          <ThreadPrimitive.Messages>
            {({ message }) => (message.role === 'user' ? <UserBubble /> : <AssistantBubble />)}
          </ThreadPrimitive.Messages>
          <ThreadPrimitive.ViewportFooter className="sticky bottom-0">
            <Composer sendError={sendError} />
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
