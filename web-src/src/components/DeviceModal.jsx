import { useState } from 'react';
import { api } from '../api.js';

// "+ cc 设备" 弹窗:原样移植现有 addDevice() 的文案和命令拼接(worker-key 换环境变量命令)。
export default function DeviceModal() {
  const [cmd, setCmd] = useState(null);

  async function addDevice() {
    const label = window.prompt('给这台 cc 设备起个名(可空):');
    if (label === null) return;
    let j;
    try {
      j = await api('/api/worker-keys', { method: 'POST', body: JSON.stringify({ label }) });
    } catch (e) {
      window.alert(e.message);
      return;
    }
    const host = location.hostname;
    setCmd(
      `HTTPS_PROXY=http://${j.key}@${host}:8898 \\\n` +
      `  CLAUDE_CODE_OAUTH_TOKEN=ssh-placeholder \\\n` +
      `  CLAUDE_CODE_OAUTH_SCOPES="user:inference user:profile user:office user:ccr_inference" \\\n` +
      `  CLAUDE_CODE_SUBSCRIPTION_TYPE=pro \\\n` +
      `  NODE_EXTRA_CA_CERTS=/path/to/ca.pem \\\n` +
      `  claude --rc`,
    );
  }

  return (
    <>
      <button className="rounded-lg border border-border px-3 py-1.5 text-sm" onClick={addDevice}>+ cc 设备</button>
      {cmd && (
        <div className="fixed inset-0 z-10 flex bg-black/60" onClick={() => setCmd(null)}>
          <div className="m-auto w-[90%] max-w-[560px] rounded-2xl border border-border bg-surface p-6" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-semibold">接入一台 cc 设备</h2>
            <p className="mt-1 text-sm text-muted">在那台机器上设好环境变量再启动 cc —— 这个 worker key 已绑定你的账户,它建立的会话只有你看得到:</p>
            <pre className="my-2.5 overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-bg p-3 text-xs">{cmd}</pre>
            <button className="rounded-lg bg-accent px-3.5 py-1.5 text-white" onClick={() => setCmd(null)}>知道了</button>
          </div>
        </div>
      )}
    </>
  );
}
