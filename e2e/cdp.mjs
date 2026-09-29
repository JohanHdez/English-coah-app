// A dependency-free Chrome DevTools Protocol client over --remote-debugging-pipe.
//
// Branded Google Chrome dropped --load-extension in 137; the supported route is
// Extensions.loadUnpacked over the pipe, which needs --enable-unsafe-extension-debugging.
// The pipe is fd 3 (commands in) and fd 4 (events and replies out), NUL-delimited JSON.

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export const CHROME = process.env.CHROME_BIN
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export class Chrome {
  constructor(proc) {
    this.proc = proc;
    this.toChrome = proc.stdio[3];
    this.fromChrome = proc.stdio[4];
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.stderr = '';
    let buf = '';
    this.fromChrome.on('data', (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf('\0')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
          else resolve(msg.result);
        } else if (msg.method) {
          for (const l of this.listeners) l(msg.method, msg.params || {}, msg.sessionId);
        }
      }
    });
    proc.stderr.on('data', (d) => { this.stderr = (this.stderr + d).slice(-20000); });
  }

  static async launch({ profile, audioFile, headless = false, extra = [] }) {
    mkdirSync(profile, { recursive: true });
    const args = [
      `--user-data-dir=${profile}`,
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      // The fake microphone: getUserMedia is granted without a prompt and delivers
      // the WAV once per opened stream (%noloop), from its first sample.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      ...(audioFile ? [`--use-file-for-fake-audio-capture=${audioFile}%noloop`] : []),
      // The WAV is read inside the audio service, whose macOS sandbox denies the
      // read: the device then delivers silence and Chrome only says so on stderr
      // ("Failed to read … as input to the fake device"). Measured, not assumed.
      '--disable-features=AudioServiceSandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=960,720',
      ...extra,
      'about:blank',
    ];
    if (headless) args.unshift('--headless=new');
    const proc = spawn(CHROME, args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    const chrome = new Chrome(proc);
    const exited = new Promise((_, reject) => proc.once('exit', (code) => reject(new Error(`Chrome exited (${code})\n${chrome.stderr.slice(-2000)}`))));
    await Promise.race([chrome.send('Browser.getVersion'), exited]);
    return chrome;
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const m = { id, method, params };
    if (sessionId) m.sessionId = sessionId;
    this.toChrome.write(JSON.stringify(m) + '\0');
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  on(handler) {
    this.listeners.push(handler);
    return () => { this.listeners = this.listeners.filter((l) => l !== handler); };
  }

  // Resolves with the first event that satisfies `test`, or rejects on timeout.
  waitFor(test, { timeoutMs = 30000, label = 'event' } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`timeout waiting for ${label}`)); }, timeoutMs);
      const off = this.on((method, params, sessionId) => {
        const hit = test(method, params, sessionId);
        if (hit === undefined || hit === false) return;
        clearTimeout(timer);
        off();
        resolve(hit);
      });
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  // userGesture: the built-in AI and speech packs only download behind a user
  // activation, which the protocol can grant a script.
  async evaluate(sessionId, expression, { awaitPromise = true, userGesture = false } = {}) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture }, sessionId);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`evaluate: ${d.exception?.description || d.text}`);
    }
    return r.result.value;
  }

  async loadUnpacked(path) {
    const { id } = await this.send('Extensions.loadUnpacked', { path });
    return id;
  }

  async close() {
    await this.send('Browser.close').catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    try { this.proc.kill(); } catch { /* already gone */ }
  }
}
