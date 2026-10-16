import { MessagePrimitive, MessagePartPrimitive } from '@assistant-ui/react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import remarkGfm from 'remark-gfm';
import ReasoningBlock from './ReasoningBlock.jsx';
import ToolCallCard from './ToolCallCard.jsx';

// 助手消息:左对齐,无气泡背景(贴近 Claude 官方那种"纯文本、极简无阴影"观感)。
// 按 part.type 分流:text 走 markdown(⚠️remarkGfm 要显式传,MarkdownTextPrimitive
// 不内置——复核时推翻了"免安装"的早期误判,见计划文档);reasoning/tool-call/image
// 各走专门组件;其余类型(目前协议里没有)交给 null,MessagePrimitive.Parts 本身
// 对未处理类型就是什么都不渲染,不是库给默认样式。
export default function AssistantBubble() {
  return (
    <MessagePrimitive.Root className="mr-auto max-w-[80%]">
      <MessagePrimitive.Parts>
        {({ part }) => {
          if (part.type === 'text') {
            return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="md leading-[1.6]" />;
          }
          if (part.type === 'reasoning') return <ReasoningBlock />;
          if (part.type === 'tool-call') return <ToolCallCard {...part} />;
          if (part.type === 'image') return <MessagePartPrimitive.Image className="mb-2 max-w-xs rounded-lg" />;
          return null;
        }}
      </MessagePrimitive.Parts>
    </MessagePrimitive.Root>
  );
}
