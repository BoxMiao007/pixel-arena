// 共享模态卡片（src/modal-card.ts）的机制守卫：node 环境没有 DOM（本仓库约定不引
// jsdom），所以这里以「源码文本 + 压平空白」钉住三件事——
//   1. 结构与类名（.settings-overlay / .status-card / .status-card-head / × /
//      .status-card-body<pre> / .status-card-actions）：外观是截图比对的承诺，动不得；
//   2. 三路关闭（× / 点遮罩本身 / Esc）汇到同一个收口函数，且先摘 document 上的
//      keydown 监听再移除遮罩（防监听泄漏）；
//   3. 底部按钮为空时不渲染按钮行（状态全文卡片是纯展示卡片，外观不能多个空行）。

import { describe, expect, it } from 'vitest';
import modalSource from './modal-card.ts?raw';

const flat = modalSource.replace(/\s+/g, '');

describe('结构：遮罩 + status-card + 头部（标题/附加按钮/×）+ 正文 <pre> + 底部按钮', () => {
  it('遮罩与面板类名沿用既有视觉语言（status-card 之后才是调用方类名）', () => {
    expect(flat).toContain("overlay.className='settings-overlay'");
    expect(flat, '面板 = status-card + 调用方附加类名').toContain(
      "panel.className=options.cardClassName?`status-card${options.cardClassName}`:'status-card'",
    );
  });

  it('头部是 .status-card-head（<h2> 标题 + 附加按钮 + ×），正文是 <pre>.status-card-body', () => {
    expect(flat).toContain("head.className='status-card-head'");
    expect(flat).toContain('heading.textContent=options.title');
    expect(flat).toContain("body.className='status-card-body'");
    expect(flat).toContain('options.lines.join');
  });

  it('底部按钮行只在有按钮时渲染（纯展示卡片不多一条空行）', () => {
    expect(flat).toContain('if(actions.length>0){');
    expect(flat).toContain("actionsBox.className='status-card-actions'");
  });

  it('按钮类名口径不变：缺省 settings-mini-btn，主操作传 settings-primary-btn', () => {
    expect(flat).toContain("button.className=spec.className??'settings-mini-btn'");
    expect(flat).toContain("closeBtn.title='关闭'");
  });
});

describe('三路关闭汇到同一个收口：× / 点遮罩本身 / Esc + keydown 监听清理', () => {
  it('×、遮罩本体、Esc 都走 close()', () => {
    expect(flat).toContain("closeBtn.addEventListener('click',close)");
    expect(flat, '只有点到遮罩本身才关').toContain(
      "overlay.addEventListener('click',(e)=>{if(e.target===overlay)close()",
    );
    expect(flat).toContain("if(e.key==='Escape')close()");
    expect(flat, 'keydown 挂在 document 上').toContain("document.addEventListener('keydown',onKey)");
  });

  it('收口里先摘 keydown 监听、再移除遮罩、最后回调 onClose', () => {
    const start = flat.indexOf('constclose=():void=>{');
    expect(start, '应有统一收口函数').toBeGreaterThanOrEqual(0);
    const end = flat.indexOf('constonKey=', start);
    const body = flat.slice(start, end);
    const remove = body.indexOf("document.removeEventListener('keydown',onKey)");
    const detach = body.indexOf('overlay.remove()');
    const done = body.indexOf('options.onClose?.()');
    expect(remove, '关闭时必须摘掉 document 上的 keydown 监听').toBeGreaterThanOrEqual(0);
    expect(detach, '先摘监听再移除遮罩').toBeGreaterThan(remove);
    expect(done, '移除遮罩之后再回调调用方').toBeGreaterThan(detach);
  });

  it('收口是幂等的：重复关闭不会二次回调（调用方靠它 resolve Promise）', () => {
    const start = flat.indexOf('constclose=():void=>{');
    const body = flat.slice(start, flat.indexOf('constonKey=', start));
    expect(body, '已关闭就直接返回').toContain('if(closed)return;');
    expect(body).toContain('closed=true;');
  });
});

describe('按钮语义由调用方描述，脚手架不外溢到调用点', () => {
  it('头部附加按钮与底部按钮共用 buildButton，回调拿到按钮本身', () => {
    expect(flat).toContain('functionbuildButton(spec:ModalCardButton)');
    expect(flat).toContain('spec.onClick?.(button)');
    expect(flat.split('buildButton(').length - 1, '头部 × + 两处按钮构造共用一份').toBe(4);
  });

  it('底部按钮点击 = 先执行调用方语义、再由共享实现关闭卡片', () => {
    expect(flat).toContain("button.addEventListener('click',()=>{spec.onClick?.(button);close();})");
  });
});
