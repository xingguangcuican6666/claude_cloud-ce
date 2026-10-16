// ═══ claude_cloud-ce:纯 Node SMTPS 发信(零依赖)═══
// 隐式 TLS(默认 465)。读 config/smtp.json:{host,port,user,pass,from,fromName}。
// AUTH LOGIN;IP 主机不设 SNI(Node 不允许对 IP 设 servername)。
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function createMailer({ log = () => {}, configFile, config } = {}) {
  let cfg = config || null;
  if (!cfg) {
    const file = configFile || path.join(process.env.CC_CONFIG || path.join(ROOT, 'config'), 'smtp.json');
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { log(`[mail] 未加载 SMTP 配置(${file}): ${e.message}`); }
  }
  const enabled = () => !!(cfg && cfg.host && cfg.user && cfg.pass);
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

  function sendMail({ to, subject, text }) {
    return new Promise((resolve, reject) => {
      if (!enabled()) return reject(new Error('SMTP 未配置'));
      const host = cfg.host, port = cfg.port || 465, from = cfg.from || cfg.user;
      const isIp = /^[0-9.]+$/.test(host);
      const msg = [
        `From: ${cfg.fromName || 'cc-cloud'} <${from}>`, `To: <${to}>`,
        `Subject: =?UTF-8?B?${b64(subject)}?=`,
        'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', text,
      ].join('\r\n') + '\r\n.';
      const steps = [
        { c: 220, s: 'EHLO cccloud.local' }, { c: 250, s: 'AUTH LOGIN' },
        { c: 334, s: b64(cfg.user) }, { c: 334, s: b64(cfg.pass) },
        { c: 235, s: `MAIL FROM:<${from}>` }, { c: 250, s: `RCPT TO:<${to}>` },
        { c: 250, s: 'DATA' }, { c: 354, s: msg }, { c: 250, s: 'QUIT' }, { c: 221, s: null },
      ];
      const sock = tls.connect({ host, port, ...(isIp ? {} : { servername: host }), rejectUnauthorized: false });
      sock.setEncoding('utf8');
      let i = 0, buf = '', id = null, settled = false;
      const fin = (code) => new RegExp(`(?:^|\\n)${code} `).test(buf);
      const done = (err) => { if (settled) return; settled = true; try { sock.end(); } catch {} err ? reject(err) : resolve(id || 'sent'); };
      sock.on('data', (d) => {
        buf += d;
        const st = steps[i]; if (!st) return;
        if (fin(st.c)) {
          const m = buf.match(/queued with id (\S+)/i); if (m) id = m[1];
          buf = '';
          if (st.s !== null) sock.write(st.s + '\r\n');
          if (++i >= steps.length) done(null);
        } else if (/(?:^|\n)[45]\d\d /.test(buf)) { done(new Error(`SMTP: ${buf.trim().split('\n').pop()}`)); }
      });
      sock.on('error', (e) => done(e));
      sock.setTimeout(20000, () => done(new Error('SMTP timeout')));
    });
  }
  return { sendMail, enabled };
}
