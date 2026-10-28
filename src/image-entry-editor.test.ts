// 票 #78（T4 逐图编辑弹窗）的前端测试，两类断言：
//
// 1. **行为**（node 环境可直接跑）：换图的编排决策抽成纯函数——步骤顺序（先清该轮
//    跑分行、再改原图、最后读新标识）、只在条目真有评测轮时清行、清行失败就不换图、
//    换完立刻变「将重跑」且编码器配置逐字段保留、新增编码器的默认值来自目录规格、
//    折叠区开合按「条目 id × 区域」双键收集与回写。
// 2. **机制**（?raw 导入源码文本 + 压平空白，仓库约定不引 jsdom）：两栏结构、共享
//    编码器卡 import、三路关闭、即时生效（无确认按钮）、右栏滚动容器、列表行点击
//    打开弹窗、宿主依赖齐全。
//
// 判定算法本身（四态 / 脏原因 / 计划拆分）已由 T2 的 image-queue.test.ts 覆盖，
// 这里只测「编辑弹窗怎么用这些结论」。

import { beforeEach, describe, expect, it } from 'vitest';
import {
  addEncoderCard,
  collectOpenRegions,
  editorHeader,
  planReplaceImage,
  restoreOpenRegions,
  runReplaceImage,
} from './image-entry-editor';
import {
  attachRound,
  clearImageQueues,
  judgeImageEntry,
  newImageEntry,
  paramFingerprint,
  probeFromCache,
  type ImageEntry,
  type ImageIdentityReading,
} from './image-queue';
import type { ImageSpec } from './advanced';
import { fileName, truncateFileName } from './util';
import editorSource from './image-entry-editor.ts?raw';
import panelSource from './image-queue-panel.ts?raw';
import mainSource from './main.ts?raw';
import css from './style.css?raw';

beforeEach(() => {
  clearImageQueues();
});

/** 一份可读的原图标识（大小/修改时间固定，便于判定）。 */
function identityOf(path: string): ImageIdentityReading {
  return { kind: 'ok', identity: { path, sizeBytes: 10, modifiedMs: 20 } };
}

/** 由「路径 → 标识」表造同步探针（与面板 probeFromCache 同一口径）。 */
function probeOf(...paths: string[]) {
  return probeFromCache(new Map(paths.map((path) => [path, identityOf(path)])));
}

/** 造一个「已成功跑过一次」的条目（快照与当前配置、原图标识都对得上）。 */
function scoredEntry(path: string): ImageEntry {
  const entry = newImageEntry(path);
  entry.snapshot = {
    identity: { path, sizeBytes: 10, modifiedMs: 20 },
    encoders: entry.encoders.map((card) => ({
      cardId: card.id,
      fingerprint: paramFingerprint(card),
      artifactPath: `${path}.out.jpg`,
    })),
  };
  return entry;
}

/** 造一份图片编码器规格（只填本票用得到的字段）。 */
function imageSpec(id: string, qualityDefault = 75): ImageSpec {
  return {
    id,
    displayName: id.toUpperCase(),
    toolKey: id,
    qualityDefault,
    qualityStep: 1,
    inputPng: true,
    outputExt: id,
    knownParams: [],
    baseArgs: [],
    losslessSupported: id !== 'jpeg',
    losslessNote: '',
    losslessArgs: [],
    qualityFlag: '-q',
    qualityMin: 1,
    qualityMax: 100,
  };
}

// ---------- 换图编排：步骤顺序与清行条件 ----------

describe('换图编排（换图 = 清旧跑分行 → 换原图 → 读新标识）', () => {
  it('有评测轮：先清该轮跑分行、再换路径；文案写明配置保留与磁盘文件保留', () => {
    const entry = scoredEntry('/photos/a.png');
    attachRound(entry, 'r-3');

    const plan = planReplaceImage(entry, '/photos/b.png', {
      name: '评测轮 3（a.png）',
      candidateCount: 2,
    });

    expect(plan.steps).toEqual([
      { kind: 'clear-candidates', roundId: 'r-3' },
      { kind: 'replace-path', path: '/photos/b.png' },
    ]);
    expect(plan.roundId).toBe('r-3');
    expect(plan.fromPath).toBe('/photos/a.png');
    expect(plan.toPath).toBe('/photos/b.png');
    expect(plan.message).toContain('编码器配置保留');
    expect(plan.message, '清行只作用于评测记录').toContain('磁盘上的产物文件保留');
    expect(plan.message).toContain('2 条跑分结果');
  });

  it('还没跑过（没有评测轮）：只换路径，不清行，文案说明工作区未改动', () => {
    const entry = newImageEntry('/photos/never.png');

    const plan = planReplaceImage(entry, '/photos/next.png', null);

    expect(plan.steps).toEqual([{ kind: 'replace-path', path: '/photos/next.png' }]);
    expect(plan.roundId).toBeNull();
    expect(plan.message).toContain('编码器配置保留');
    expect(plan.message).toContain('工作区未改动');
    expect(plan.message).toContain('磁盘上的产物文件保留');
  });

  it('roundId 指向的轮已不在工作区（外面删过）：不拿旧 id 去清行', () => {
    const entry = newImageEntry('/photos/gone.png');
    attachRound(entry, 'r-7');

    const plan = planReplaceImage(entry, '/photos/new.png', null);

    expect(plan.steps).toEqual([{ kind: 'replace-path', path: '/photos/new.png' }]);
    expect(plan.roundId).toBeNull();
  });

  // 文档 0031 / README 把「更换图片」当作抓不到修改时间时的自救路径（外部工具原地
  // 覆写同名同大小文件），所以选回同一路径必须照样走换图：清行 + 置 replaced 强制置脏。
  it('选回同一张图：照样清行 + 置 replaced（同一路径也要能强制重跑）', async () => {
    const entry = scoredEntry('/photos/a.png');
    attachRound(entry, 'r-3');
    const observed: string[] = [];

    const plan = planReplaceImage(entry, '/photos/a.png', { name: '轮', candidateCount: 1 });
    await runReplaceImage(plan, entry, {
      clearCandidates: async (roundId) => {
        observed.push(`clear:${roundId}`);
      },
      refreshIdentity: async (path) => {
        observed.push(`identity:${path}`);
      },
    });

    expect(plan.steps).toEqual([
      { kind: 'clear-candidates', roundId: 'r-3' },
      { kind: 'replace-path', path: '/photos/a.png' },
    ]);
    expect(observed).toEqual(['clear:r-3', 'identity:/photos/a.png']);
    // 旧结果整体作废：状态必须变「将重跑（图片换了）」，否则原始 no-op 会让人白等
    expect(entry.snapshot).toBeNull();
    expect(entry.replaced).toBe(true);
    const verdict = judgeImageEntry(entry, probeOf('/photos/a.png'));
    expect(verdict.state).toBe('stale');
    expect(verdict.reasons).toContain('image');
    expect(plan.message, '同一路径也要说清楚做了什么').toContain('同一路径');
    expect(plan.message, '不再有「未做更改」的 no-op 文案').not.toContain('未做更改');
  });

  it('同一路径且还没有评测轮：只置 replaced（工作区未改动，状态同样变将重跑）', async () => {
    const entry = scoredEntry('/photos/a.png');
    const observed: string[] = [];

    await runReplaceImage(planReplaceImage(entry, '/photos/a.png', null), entry, {
      clearCandidates: async (roundId) => {
        observed.push(`clear:${roundId}`);
      },
      refreshIdentity: async (path) => {
        observed.push(`identity:${path}`);
      },
    });

    expect(observed).toEqual(['identity:/photos/a.png']);
    expect(entry.replaced).toBe(true);
    expect(entry.snapshot).toBeNull();
    expect(judgeImageEntry(entry, probeOf('/photos/a.png')).state).toBe('stale');
  });

  it('按计划执行：可观察的顺序是「清行 → 换图 → 读新标识」', async () => {
    const entry = scoredEntry('/photos/a.png');
    attachRound(entry, 'r-3');
    const observed: string[] = [];

    await runReplaceImage(
      planReplaceImage(entry, '/photos/b.png', { name: '评测轮 3（a.png）', candidateCount: 1 }),
      entry,
      {
        clearCandidates: async (roundId) => {
          observed.push(`clear:${roundId}`);
        },
        refreshIdentity: async (path) => {
          observed.push(`identity:${path}`);
        },
      },
    );

    expect(observed).toEqual(['clear:r-3', 'identity:/photos/b.png']);
    expect(entry.path).toBe('/photos/b.png');
    expect(entry.snapshot).toBeNull();
    expect(entry.failures).toEqual([]);
    expect(entry.replaced).toBe(true);
  });

  it('清行失败：不换图（旧路径与旧跑分结果原样保留，可重试）', async () => {
    const entry = scoredEntry('/photos/a.png');
    attachRound(entry, 'r-3');
    const before = probeOf('/photos/a.png');

    await expect(
      runReplaceImage(
        planReplaceImage(entry, '/photos/b.png', { name: '轮', candidateCount: 1 }),
        entry,
        {
          clearCandidates: async () => {
            throw new Error('清空跑分行失败：IPC 超时');
          },
          refreshIdentity: async () => undefined,
        },
      ),
    ).rejects.toThrow('清空跑分行失败');

    expect(entry.path).toBe('/photos/a.png');
    expect(entry.replaced).toBe(false);
    expect(judgeImageEntry(entry, before).state).toBe('scored');
  });
});

// ---------- 换图后的状态与配置 ----------

describe('换图后状态立即变「将重跑」，配置原样保留', () => {
  it('换图后同一判定入口立刻给出 stale + 原因「图片换了」', async () => {
    const entry = scoredEntry('/photos/a.png');
    attachRound(entry, 'r-3');
    const before = entry.encoders.map((card) => paramFingerprint(card));
    const probe = probeOf('/photos/a.png', '/photos/b.png');
    expect(judgeImageEntry(entry, probe).state).toBe('scored');

    await runReplaceImage(
      planReplaceImage(entry, '/photos/b.png', { name: '轮', candidateCount: 1 }),
      entry,
      {
        clearCandidates: async () => undefined,
        refreshIdentity: async () => undefined,
      },
    );

    const verdict = judgeImageEntry(entry, probe);
    expect(verdict.state).toBe('stale');
    expect(verdict.reasons).toContain('image');
    expect(verdict.imageId).toBe(entry.id);
    // 配置逐字段保留：指纹（编码器/模式/质量/目标大小/参数行）与换图前一致
    expect(entry.encoders.map((card) => paramFingerprint(card))).toEqual(before);
  });

  it('条目自身（会话态对象）就是唯一数据源：改参数后判定立刻变「参数改了」', () => {
    const entry = scoredEntry('/photos/a.png');
    const probe = probeOf('/photos/a.png');
    expect(judgeImageEntry(entry, probe).state).toBe('scored');

    entry.encoders[0].quality += 1; // 弹窗里改质量就是直接改这个对象

    const verdict = judgeImageEntry(entry, probe);
    expect(verdict.state).toBe('stale');
    expect(verdict.reasons).toContain('params');
    expect(editorHeader(entry, verdict).status).toContain('参数改了');
  });
});

// ---------- 弹窗头部与新增编码器 ----------

describe('弹窗头部（文件名 + 当前状态）', () => {
  it('标题带上中间截断的文件名，状态文案取 T2 的单一来源', () => {
    const entry = newImageEntry('/photos/一张名字非常非常长的照片文件abcdefghijklmnop.png');
    const header = editorHeader(entry, judgeImageEntry(entry, probeOf()));

    expect(header.title).toBe(`编辑图片：${truncateFileName(fileName(entry.path))}`);
    expect(header.fileName).toBe(truncateFileName(fileName(entry.path)));
    expect(header.status).toBe('未跑分');
    expect(header.statusClass).toBe('queue-badge queue-badge-unscored');
  });

  it('四态各有对应徽章 class（左栏与头部用同一个 header）', () => {
    expect(editorHeader(newImageEntry('/a.png'), judgeImageEntry(newImageEntry('/a.png'), probeOf())).statusClass).toContain(
      'queue-badge-unscored',
    );
    const stale = newImageEntry('/b.png');
    stale.replaced = true;
    const staleVerdict = judgeImageEntry(stale, probeOf());
    expect(staleVerdict.state).toBe('stale');
    expect(editorHeader(stale, staleVerdict).statusClass).toBe('queue-badge queue-badge-stale');
  });
});

describe('新增编码器（右栏「＋ 添加编码器」）', () => {
  it('优先加 JPEG（与新条目默认配置同口径），取它的默认质量', () => {
    const entry = newImageEntry('/photos/a.png');

    const card = addEncoderCard(entry, [imageSpec('webp', 80), imageSpec('jpeg', 75)]);

    expect(card).not.toBeNull();
    expect(entry.encoders).toHaveLength(2);
    expect(entry.encoders[1]).toMatchObject({
      kind: 'image',
      encoderId: 'jpeg',
      lossless: false,
      mode: 'quality',
      quality: 75,
      rows: [],
    });
  });

  it('目录里没有 JPEG 时退回第一条规格（加得出卡比加不出好）', () => {
    const entry = newImageEntry('/photos/a.png');

    const card = addEncoderCard(entry, [imageSpec('webp', 80)]);

    expect(card).not.toBeNull();
    expect(entry.encoders[1]).toMatchObject({ encoderId: 'webp', quality: 80 });
  });

  it('目录为空时不加卡（避免加出一张没有规格可调的卡）', () => {
    const entry = newImageEntry('/photos/a.png');
    const before = entry.encoders.length;

    expect(addEncoderCard(entry, [])).toBeNull();
    expect(entry.encoders).toHaveLength(before);
  });
});

// ---------- 折叠区开合：条目 id × 区域 双键 ----------

interface FakeDetails {
  dataset: { advRegion: string };
  open: boolean;
}

/** 轻量假 DOM：只实现本模块用到的 querySelectorAll 结构，避免引入 jsdom。 */
function fakeRoot(cards: Array<{ id: string; details: FakeDetails[] }>): ParentNode {
  return {
    querySelectorAll: (selector: string) =>
      selector === '.adv-entry'
        ? cards.map((card) => ({
            dataset: { entryId: card.id },
            querySelectorAll: (inner: string) =>
              inner === 'details[data-adv-region]' ? card.details : [],
          }))
        : [],
  } as unknown as ParentNode;
}

/** 造一个带缺省开合状态的折叠区（模拟整卡重建后的新 DOM）。 */
function details(region: string, open: boolean): FakeDetails {
  return { dataset: { advRegion: region }, open };
}

describe('整卡重建的折叠区回写：entryId × data-adv-region 双键', () => {
  it('同一张卡里「高级参数」与「命令行预览」分别回写，互不串（只按 id 会丢预览展开态）', () => {
    const aAdvanced = details('advanced', false);
    const aPreview = details('preview', true); // 用户展开了命令行预览
    const bAdvanced = details('advanced', true);
    const bPreview = details('preview', false);

    const prevOpen = collectOpenRegions(
      fakeRoot([
        { id: 'adv-1', details: [aAdvanced, aPreview] },
        { id: 'adv-2', details: [bAdvanced, bPreview] },
      ]),
    );

    // 重建：新卡片回到默认（高级参数展开、命令行预览收起）
    const aAdvanced2 = details('advanced', true);
    const aPreview2 = details('preview', false);
    const bAdvanced2 = details('advanced', true);
    const bPreview2 = details('preview', false);
    restoreOpenRegions(
      fakeRoot([
        { id: 'adv-1', details: [aAdvanced2, aPreview2] },
        { id: 'adv-2', details: [bAdvanced2, bPreview2] },
      ]),
      prevOpen,
    );

    expect(aPreview2.open, '条目 1 的预览展开态要按区域键回写').toBe(true);
    expect(aAdvanced2.open).toBe(false);
    expect(bPreview2.open).toBe(false);
    expect(bAdvanced2.open).toBe(true);
  });

  it('新加的卡片在 Map 里查不到，保持默认（不误写相邻条目的开合）', () => {
    const prevOpen = collectOpenRegions(
      fakeRoot([{ id: 'adv-1', details: [details('advanced', false), details('preview', true)] }]),
    );
    const freshAdvanced = details('advanced', true);
    const freshPreview = details('preview', false);

    restoreOpenRegions(fakeRoot([{ id: 'adv-9', details: [freshAdvanced, freshPreview] }]), prevOpen);

    expect(freshAdvanced.open).toBe(true);
    expect(freshPreview.open).toBe(false);
  });
});

// ---------- DOM 机制守卫（?raw 源码文本 + 压平空白，仓库约定不引 jsdom） ----------

const flatEditor = editorSource.replace(/\s+/g, '');
const flatPanel = panelSource.replace(/\s+/g, '');
const flatMain = mainSource.replace(/\s+/g, '');
const flatCss = css.replace(/\s+/g, '');

describe('左图右参两栏结构与右栏滚动（票面验收）', () => {
  it('弹窗有左栏（图片区）与右栏（参数区）两个命名容器', () => {
    expect(flatEditor).toContain("side.className='queue-editor-side'");
    expect(flatEditor).toContain("main.className='queue-editor-main'");
    expect(flatEditor).toContain("body.className='queue-editor-body'");
    // 左栏放文件名 / 状态 / 更换图片；右栏放共享编码器卡容器
    expect(flatEditor).toContain('side.append(sideTitle,sideName,sideBadge,pathEl,sideActions,sideHint)');
    expect(flatEditor).toContain('main.append(mainHead,cardsBox)');
  });

  it('右栏是滚动容器：面板不整体滚动，参数再多也不把窗口撑爆', () => {
    const start = flatCss.indexOf('.queue-editor-panel{');
    expect(start, '样式表缺少 .queue-editor-panel 规则块').toBeGreaterThanOrEqual(0);
    const panelBlock = flatCss.slice(start, flatCss.indexOf('}', start) + 1);
    expect(panelBlock, '面板本身不滚动（由右栏内部滚动）').toContain('overflow:hidden');

    const mainStart = flatCss.indexOf('.queue-editor-main{');
    expect(mainStart, '样式表缺少 .queue-editor-main 规则块').toBeGreaterThanOrEqual(0);
    const mainBlock = flatCss.slice(mainStart, flatCss.indexOf('}', mainStart) + 1);
    expect(mainBlock, '右栏整体滚动').toContain('overflow-y:auto');
    expect(mainBlock).toContain('min-height:0');
  });

  it('窄窗口降为单列（左右两栏不重叠、不溢出）', () => {
    const start = flatCss.indexOf('.queue-editor-body{');
    const block = flatCss.slice(start, flatCss.indexOf('}', start) + 1);
    expect(block).toContain('grid-template-columns:minmax(0,260px)minmax(0,1fr)');
    expect(flatCss, '窄窗口须有单列回退').toContain(
      '@media(max-width:640px){.queue-editor-body{grid-template-columns:minmax(0,1fr)',
    );
  });
});

describe('左栏图片区（文件名 / 状态 / 更换图片）', () => {
  it('更换图片按钮走系统单选对话框与换图编排，并清对应轮跑分行', () => {
    expect(flatEditor).toContain("replaceBtn.textContent='更换图片'");
    expect(flatEditor, '选一个图片文件').toContain('awaitdeps.pickImage()');
    expect(flatEditor).toContain('planReplaceImage(');
    expect(flatEditor).toContain('runReplaceImage(');
    expect(flatEditor, '换图落会话态用 T2 的 replaceImagePath').toContain('replaceImagePath(entry,step.path)');
    expect(flatEditor, '清行经注入的宿主能力').toContain(
      'clearCandidates:(roundId)=>deps.clearCandidates(groupId,roundId)',
    );
    expect(flatEditor).toContain('deps.describeRound(');
  });

  it('左栏显示文件名与状态（两者都取 editorHeader 的同一份结论）', () => {
    expect(flatEditor).toContain('constheader=editorHeader(entry,verdict())');
    expect(flatEditor).toContain('sideName.textContent=header.fileName');
    expect(flatEditor).toContain('sideBadge.textContent=header.status');
    expect(flatEditor).toContain('headBadge.textContent=header.status');
  });
});

describe('右栏参数区：共享编码器卡（不另写一份卡片）', () => {
  it('从 src/encoder-card 导入 renderEncoderCard 并直接渲染', () => {
    expect(flatEditor).toMatch(
      /import\{[^}]*renderEncoderCard[^}]*\}from'\.\/encoder-card'/,
    );
    expect(flatEditor).toContain('renderEncoderCard(card,index,catalog,{');
    // 卡片布局细节（卡头 / 快速参数网格 / 参数行）不应在弹窗里复制一份
    expect(flatEditor).not.toContain('adv-entry-head');
    expect(flatEditor).not.toContain('adv-quick-grid');
  });

  it('推荐参数下拉的收起范围限定在右栏（menuRoot 传卡片容器，不扫整个 document）', () => {
    expect(flatEditor).toContain('menuRoot:cardsBox');
    expect(flatEditor).toContain('closeEncoderMenus(cardsBox)');
  });

  it('加/删/排序/恢复默认/复制全部接共享卡的回调，改动立即写会话态', () => {
    for (const callback of [
      'onChange:()=>{renderCards();notifyChanged();}',
      'onMove:(delta)=>{moveCard(entry,index,delta);renderCards();notifyChanged();}',
      'onRemove:()=>{entry.encoders.splice(index,1);renderCards();notifyChanged();}',
      'onReset:()=>{renderCards();notifyChanged();}',
      'onCopy:copyLine',
    ]) {
      expect(flatEditor, `缺少回调 ${callback}`).toContain(callback);
    }
    expect(flatEditor, '新增编码器').toContain('addEncoderCard(entry,imageSpecs)');
    expect(flatEditor, '复制命令行复用 util.copyText').toContain('copyText(text,');
  });
});

describe('即时生效（没有确认/应用这一步）', () => {
  it('弹窗源码里不存在确定/应用/保存按钮的文案（改动直接落在会话态对象上）', () => {
    expect(flatEditor).not.toContain('确定');
    expect(flatEditor).not.toContain('应用');
    expect(flatEditor).not.toContain('保存');
  });

  it('参数变化（input/change）与卡片操作都会通知列表刷新状态', () => {
    expect(flatEditor).toContain("cardsBox.addEventListener('input',onLiveEdit)");
    expect(flatEditor).toContain("cardsBox.addEventListener('change',onLiveEdit)");
    expect(flatEditor).toContain('constonLiveEdit=():void=>{syncStatus();deps.onChanged();}');
  });
});

describe('三路关闭（× / 点遮罩 / Esc）与监听清理', () => {
  it('关闭函数先摘 document 监听再移除遮罩，三路都汇到它', () => {
    const start = flatEditor.indexOf('exportasyncfunctionopenImageEntryEditor(');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = flatEditor.slice(start);
    expect(body).toContain("closeBtn.addEventListener('click',close)");
    expect(body).toContain("overlay.addEventListener('click',(e)=>{if(e.target===overlay)close()");
    expect(body).toContain("if(e.key==='Escape')close()");
    expect(body).toContain("document.addEventListener('keydown',onKey)");
    const remove = body.indexOf("document.removeEventListener('keydown',onKey)");
    const detach = body.indexOf('overlay.remove()');
    expect(remove).toBeGreaterThanOrEqual(0);
    expect(detach).toBeGreaterThan(remove);
  });

  it('关闭后回列表：打开返回 Promise，面板在 finally 里重渲染列表', () => {
    expect(flatEditor).toContain('resolve()');
    expect(flatPanel).toContain('.finally(()=>{editorOpen=false;renderList();})');
  });
});

describe('列表行点击打开编辑弹窗（不是选中态）', () => {
  it('行有点击入口，删除按钮阻止冒泡（点 × 不顺手打开编辑窗）', () => {
    expect(flatPanel).toContain("row.addEventListener('click',()=>openEditor(entry))");
    // 票 #82：弹窗依赖收进共享运行时（主界面点胶囊用的是同一份接线）
    expect(flatPanel).toContain(
      'openImageEntryEditor(groupId,entry,queueEditorDeps(groupId,deps,()=>renderList()))',
    );
    expect(flatPanel).toContain("del.addEventListener('click',(e)=>{e.stopPropagation()");
  });

  it('同一次运行只开一个编辑弹窗，关闭后列表原地同步', () => {
    expect(flatPanel).toContain('leteditorOpen=false');
    expect(flatPanel).toContain('if(editorOpen||running||deps.isBusy())return');
    expect(flatPanel).toContain('queueEditorDeps(groupId,deps,()=>renderList())');
  });
});

describe('主界面宿主依赖（main.ts）', () => {
  it('更换图片用单选系统对话框、图片编码器目录走 advanced_image_catalog', () => {
    const start = flatMain.indexOf('functionimageQueueHostDeps(');
    expect(start, '宿主依赖应收成一份 imageQueueHostDeps').toBeGreaterThanOrEqual(0);
    const end = flatMain.indexOf('functionopenImageQueueCreation(', start);
    const body = flatMain.slice(start, end);
    expect(body).toContain('pickReplacementImage:');
    expect(body, '更换图片是单选').toContain('multiple:false');
    expect(body, '目录加载复用后端规格表').toContain(
      "invoke<ImageSpec[]>('advanced_image_catalog')",
    );
  });
});
