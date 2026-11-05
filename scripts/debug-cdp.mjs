// 调试实例的 CDP 小工具：在独立调试实例的 WebView2 里执行脚本、截图、模拟输入。
// 用法（默认端口 9223，可用 -p 或 PIXEL_ARENA_DEBUG_PORT 改）：
//   node scripts/debug-cdp.mjs eval "<js 表达式>"
//   node scripts/debug-cdp.mjs shot demo.png          # 落到 .tmp/debug-shots/demo.png
//   node scripts/debug-cdp.mjs window 900 700         # 改调试实例窗口大小（触发 @media 断点）
//   node scripts/debug-cdp.mjs click 120 40
//   node scripts/debug-cdp.mjs drag 640 400 640 120 8
//   node scripts/debug-cdp.mjs key ArrowLeft [shift]
//   node scripts/debug-cdp.mjs wait 500
//   node scripts/debug-cdp.mjs targets                # 列出可调试页面
//
// 合成事件走浏览器输入管线（pointer capture 有效），不动系统鼠标、不抢焦点；
// 截图取的是 WebView 画布，与窗口层级无关。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const argv = process.argv.slice(2);
let port = Number(process.env.PIXEL_ARENA_DEBUG_PORT || 0) || 9223;
const portIndex = argv.indexOf('-p');
if (portIndex >= 0) {
  port = Number(argv[portIndex + 1]);
  argv.splice(portIndex, 2);
}
const [command, ...rest] = argv;

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
if (command === 'targets') {
  console.log(JSON.stringify(list.map((t) => ({ type: t.type, title: t.title, url: t.url })), null, 2));
  process.exit(0);
}

const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
if (!page) throw new Error(`端口 ${port} 上没有可调试页面（调试实例起了吗？scripts/debug-instance.ps1 start）`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', () => reject(new Error(`连不上 CDP：ws://127.0.0.1:${port}`)), { once: true });
});

const pending = new Map();
let nextId = 1;
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(event.data);
  const settle = pending.get(msg.id);
  if (settle) {
    pending.delete(msg.id);
    settle(msg);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 超时：${method}`));
    }, 20000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) {
        reject(new Error(`CDP 报错：${method} ${JSON.stringify(msg.error)}`));
        return;
      }
      resolve(msg.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

switch (command) {
  case 'eval': {
    const reply = await send('Runtime.evaluate', {
      expression: rest.join(' '),
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (reply.exceptionDetails) {
      console.error('EXCEPTION', JSON.stringify(reply.exceptionDetails));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(reply.result?.value ?? null));
    }
    break;
  }
  case 'shot': {
    const name = rest[0] ?? `shot-${Date.now()}.png`;
    const out = path.isAbsolute(name) || name.includes('/') || name.includes('\\')
      ? path.resolve(repo, name)
      : path.join(repo, '.tmp', 'debug-shots', name);
    await fs.mkdir(path.dirname(out), { recursive: true });
    const reply = await send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(out, Buffer.from(reply.data, 'base64'));
    console.log('saved', out);
    break;
  }
  case 'window': {
    // 改的是调试实例自己的窗口（真正影响 @media 断点）；Emulation 的视口覆盖实测
    // 在 WebView2 里不生效，别指望它。
    const width = Number(rest[0]);
    const height = Number(rest[1]);
    const { windowId, bounds } = await send('Browser.getWindowForTarget');
    const next = { width, height };
    if (bounds?.windowState && bounds.windowState !== 'normal') next.windowState = 'normal';
    await send('Browser.setWindowBounds', { windowId, bounds: next });
    await sleep(400);
    const shown = await send('Runtime.evaluate', {
      expression: '`${window.innerWidth}x${window.innerHeight}`',
      returnByValue: true,
    });
    console.log('window', width, height, '视口', shown.result?.value);
    break;
  }
  case 'click': {
    const [x, y] = rest.map(Number);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', {
        type,
        x,
        y,
        button: 'left',
        buttons: type === 'mousePressed' ? 1 : 0,
        clickCount: 1,
      });
    }
    await sleep(200);
    console.log('clicked', x, y);
    break;
  }
  case 'drag': {
    const [x1, y1, x2, y2, steps = 8] = rest.map(Number);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= steps; i += 1) {
      const x = x1 + ((x2 - x1) * i) / steps;
      const y = y1 + ((y2 - y1) * i) / steps;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
      await sleep(30);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(300);
    console.log('dragged', x1, y1, '->', x2, y2);
    break;
  }
  case 'key': {
    const named = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Home: 36, End: 35, Enter: 13, Escape: 27, Space: 32, Tab: 9 };
    const key = rest[0];
    const vk = named[key] ?? key.toUpperCase().charCodeAt(0);
    const base = {
      key: key === 'Space' ? ' ' : key,
      code: key === 'Space' ? 'Space' : key,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
      modifiers: rest[1] === 'shift' ? 8 : 0,
    };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(200);
    console.log('key', key);
    break;
  }
  case 'wait': {
    await sleep(Number(rest[0] ?? 500));
    console.log('waited');
    break;
  }
  default: {
    console.error('用法：debug-cdp.mjs [-p 端口] eval|shot|window|click|drag|key|wait|targets');
    process.exitCode = 2;
  }
}

ws.close();
