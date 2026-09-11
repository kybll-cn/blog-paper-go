/**
 * cdp.js —— 极简 Chrome DevTools Protocol 客户端（无第三方依赖）
 *
 * 为什么需要它：
 *   Windows 上 Chrome 的 `--window-size` 有 500px 最小宽度硬限制，
 *   且 `--dump-dom` 与 `--screenshot` 走的渲染路径不一致 ——
 *   想测 430px 手机视口，`--window-size=430,900` 实测 innerWidth=500（假数据）。
 *   只有 Emulation.setDeviceMetricsOverride 能给出任意精确视口，
 *   并且测量与截图走同一套度量，结果自洽。
 *
 * Node 22 自带全局 WebSocket，故无需 ws 依赖。
 *
 * 用法：
 *   const { launch } = require('./cdp');
 *   const b = await launch();
 *   await b.viewport(430, 900);
 *   await b.goto(url);
 *   const data = await b.evalJson('JSON.stringify(...)');
 *   await b.shot('out.png', { full: false });
 *   await b.close();
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));

class Browser {
  constructor(proc, ws, prof, port) {
    this.proc = proc; this.ws = ws; this.prof = prof; this.port = port;
    this._id = 0; this._waiters = new Map(); this._events = [];
  }

  send(method, params = {}, sessionId) {
    const id = ++this._id;
    return new Promise((resolve, reject) => {
      this._waiters.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      setTimeout(() => {
        if (this._waiters.has(id)) { this._waiters.delete(id); reject(new Error('CDP 超时: ' + method)); }
      }, 30000);
    });
  }

  /** 覆盖设备度量 —— 唯一的精确视口控制手段 */
  async viewport(width, height, opts = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width, height,
      deviceScaleFactor: opts.dsf || 1,
      mobile: opts.mobile !== false,
      screenWidth: width, screenHeight: height,
    });
  }

  /** 导航并等待 load（用轮询 readyState 兜底，不依赖事件时序） */
  async goto(url, timeoutMs = 20000) {
    await this.send('Page.navigate', { url });
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      await sleep(120);
      try {
        const rs = await this.eval('document.readyState');
        if (rs === 'complete') { await sleep(250); return true; }
      } catch (e) { /* 导航中，继续等 */ }
    }
    throw new Error('页面加载超时: ' + url);
  }

  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result && r.result.value;
  }

  async evalJson(expr) {
    const v = await this.eval(expr);
    return typeof v === 'string' ? JSON.parse(v) : v;
  }

  /** 截图。full=true 抓整页（用布局高度重设度量，避免长图被裁） */
  async shot(file, opts = {}) {
    let params = { format: 'png' };
    if (opts.full) {
      const h = await this.eval('Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)');
      const vw = await this.eval('window.innerWidth');
      await this.viewport(vw, Math.min(h, 8000), { mobile: false });
      params.captureBeyondViewport = true;
    }
    if (opts.clip) params.clip = Object.assign({ scale: 1 }, opts.clip);
    const r = await this.send('Page.captureScreenshot', params);
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  }

  async close() {
    try { this.ws.close(); } catch (e) {}
    try { this.proc.kill(); } catch (e) {}
    await sleep(200);
    try { fs.rmSync(this.prof, { recursive: true, force: true }); } catch (e) {}
  }
}

/**
 * 启动一个 headless Chrome 并连上 CDP
 * @param {{port?:number}} opts
 * @returns {Promise<Browser>}
 */
async function launch(opts = {}) {
  if (!fs.existsSync(CHROME)) throw new Error('未找到 Chrome: ' + CHROME);
  const port = opts.port || (9300 + (process.pid % 400));
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'rom-cdp-'));
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--no-first-run', '--no-default-browser-check', '--disable-extensions',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + prof,
    'about:blank',
  ], { stdio: 'ignore' });

  // 等 DevTools 端口起来，取页面级 WebSocket 地址
  let wsUrl = null;
  for (let i = 0; i < 60; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) { wsUrl = page.webSocketDebuggerUrl; break; }
    } catch (e) { /* 还没起来 */ }
    await sleep(200);
  }
  if (!wsUrl) { try { proc.kill(); } catch (e) {} throw new Error('无法连接 CDP（端口 ' + port + '）'); }

  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WebSocket 连接失败')), { once: true });
    setTimeout(() => rej(new Error('WebSocket 连接超时')), 10000);
  });

  const b = new Browser(proc, ws, prof, port);
  ws.addEventListener('message', ev => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id && b._waiters.has(msg.id)) {
      const w = b._waiters.get(msg.id);
      b._waiters.delete(msg.id);
      msg.error ? w.reject(new Error(msg.error.message)) : w.resolve(msg.result);
    } else if (msg.method) {
      b._events.push(msg);
    }
  });

  await b.send('Page.enable');
  await b.send('Runtime.enable');
  return b;
}

module.exports = { launch, sleep };
