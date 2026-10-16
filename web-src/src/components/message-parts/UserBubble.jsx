import { MessagePrimitive, MessagePartPrimitive } from '@assistant-ui/react';

// 用户消息气泡:右对齐。历史会话里用户消息偶尔会带图片(真机终端里贴的截图),
// 所以除了 text 也接一下 image;reasoning/tool-call 不会出现在 user 消息里,交给
// 默认 null 分支(MessagePrimitive.Parts 对未处理类型本就什么都不渲染)。
export default function UserBubble() {
  return (
    <MessagePrimitive.Root className="ml-auto flex max-w-[80%] flex-col items-end">
      <MessagePrimitive.Parts>
        {({ part }) => {
          if (part.type === 'text') {
            return (
              <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-bubble-user px-4 py-2.5 text-[16px] leading-[1.6]">
                <MessagePartPrimitive.Text />
              </div>
            );
          }
          if (part.type === 'image') {
            return <MessagePartPrimitive.Image className="mb-1 max-w-xs rounded-lg" />;
          }
          return null;
        }}
      </MessagePrimitive.Parts>
    </MessagePrimitive.Root>
  );
}
