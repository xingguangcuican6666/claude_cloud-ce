import { ComposerPrimitive } from '@assistant-ui/react';

// 输入框 + 发送按钮,渲染在 ThreadPrimitive.ViewportFooter(sticky bottom-0)里,是贴近
// Claude 官方观感的"浮动卡片"而不是通栏工具条——父层的 Viewport 自带 p-4,所以这里
// 不需要再包一层背景/padding,直接是悬浮的圆角输入框。ComposerPrimitive.Input 内部是
// react-textarea-autosize,自带 Enter 发送/Shift+Enter 换行、且正确处理中文输入法的组合键
// (不会在拼音候选阶段误触发送)——比现状 web/index.html 手写的 keydown 判断更correct。
// 不渲染 ComposerPrimitive.Cancel("停止生成"):/api/sessions 系列路由没有暴露中断单轮的
// 接口,接了也是个点了没反应的按钮(计划里的明确决定)。
export default function Composer({ sendError }) {
  return (
    <div className="pt-2">
      <ComposerPrimitive.Root className="flex items-end gap-2 rounded-2xl border border-border bg-surface px-3.5 py-2.5">
        <ComposerPrimitive.Input
          rows={1}
          placeholder="给这个会话发消息…(Enter 发送 / Shift+Enter 换行)"
          className="max-h-40 flex-1 resize-none bg-transparent text-[16px] leading-[1.5] outline-none placeholder:text-muted"
        />
        <ComposerPrimitive.Send className="shrink-0 rounded-lg bg-accent px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-40">
          发送
        </ComposerPrimitive.Send>
      </ComposerPrimitive.Root>
      {sendError && <p className="mt-1.5 text-sm text-red-500">发送失败:{sendError}</p>}
    </div>
  );
}
