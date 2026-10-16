import { MessagePartPrimitive } from '@assistant-ui/react';

// 思考过程(thinking/redacted_thinking block),可折叠,默认收起——贴近 Claude 官方观感。
// MessagePartPrimitive.Text 内部读的是 part context 里的文本(useMessagePartText 对
// text/reasoning 两种 part 类型通用),自带平滑逐字显现动画,不用自己手写打字机效果。
export default function ReasoningBlock() {
  return (
    <details className="mb-2 text-sm text-muted">
      <summary className="cursor-pointer select-none">思考过程</summary>
      <div className="mt-1 whitespace-pre-wrap border-l-2 border-border pl-3 opacity-80">
        <MessagePartPrimitive.Text />
      </div>
    </details>
  );
}
