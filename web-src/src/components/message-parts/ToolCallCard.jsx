// 工具调用卡片:取代现状手写的 <details>。props 直接来自 EnrichedPartState 的 tool-call 分支
// (toolCallId/toolName/args/argsText/result/isError),不接 addResult/resume/respondToApproval——
// 我们的工具全部在远程 worker 侧执行,web 端只读展示,不需要客户端侧工具执行/审批那套机制。
export default function ToolCallCard({ toolName, args, argsText, result, isError }) {
  const hasResult = result !== undefined;
  const argsDisplay = args && Object.keys(args).length ? JSON.stringify(args, null, 2) : (argsText || '');
  return (
    <details className="mb-2 rounded-lg border border-border bg-surface p-2 text-xs" open={!hasResult}>
      <summary className="cursor-pointer select-none font-mono text-accent">
        {toolName}{!hasResult && <span className="ml-1 animate-pulse text-muted">· 执行中</span>}
      </summary>
      {argsDisplay && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">{argsDisplay}</pre>}
      {hasResult && (
        <pre className={`mt-1 overflow-x-auto whitespace-pre-wrap ${isError ? 'text-red-500' : 'text-muted'}`}>
          {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </details>
  );
}
