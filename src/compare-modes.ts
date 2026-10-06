// T09 三种对比模式（叠加 / 差异图 / 闪烁切换）的模块：
// - computeDiffData：逐像素差异的纯逻辑（PixelBuffer 输入输出，无 DOM），由 compare-modes.test.ts 守护；
// - renderDiffCanvas：把两整张图生成一张差异画布（缓存键见 viewer.ts 接线处）；
// - 控件与闪烁定时器：叠加不透明度、差异阈值、闪烁播放，控件状态由查看器按评测轮持有
//   （T25 起每轮一份，见 CompareUiState），本模块只按传入的状态构建控件、不自己存状态；
//   闪烁定时器仍是模块级单定时器（同一时刻只挂一个）。
// viewer.ts 只做接线：模式按钮注册 + draw() 分支调用本模块（并行票合并时按「T09 接线」注释找点）。

// ---------- 纯逻辑：逐像素差异热图 ----------

/** 与 ImageData 结构兼容的最小像素缓冲（测试环境无 DOM 也能构造） */
export interface PixelBuffer {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/**
 * 逐像素计算差异热图（要求 ref 与 cand 同尺寸，调用方保证）：
 * - 亮度 L = 0.299R + 0.587G + 0.114B，亮度差 diff = |L_ref - L_cand|（0~255）；
 * - diff ≤ 阈值：输出原图亮度 25% 的灰阶底——保留轮廓上下文又不抢眼；
 * - diff > 阈值：热区着色，超出程度从黄 (255,230,0) 渐变到纯红 (255,0,0)，
 *   越接近阈值越偏黄（刚过线）、差得越多越红。
 * 返回长度 = 像素数 ×4 的 RGBA 数组（alpha 恒 255）。
 */
export function computeDiffData(
  ref: PixelBuffer,
  cand: PixelBuffer,
  threshold: number,
): Uint8ClampedArray {
  const n = ref.width * ref.height;
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const lr = 0.299 * ref.data[o]! + 0.587 * ref.data[o + 1]! + 0.114 * ref.data[o + 2]!;
    const lc = 0.299 * cand.data[o]! + 0.587 * cand.data[o + 1]! + 0.114 * cand.data[o + 2]!;
    const diff = Math.abs(lr - lc);
    if (diff <= threshold) {
      const g = Math.round(lr * 0.25);
      out[o] = g;
      out[o + 1] = g;
      out[o + 2] = g;
    } else {
      const p = (diff - threshold) / (255 - threshold);
      out[o] = 255;
      out[o + 1] = Math.round(230 * (1 - p));
      out[o + 2] = 0;
    }
    out[o + 3] = 255;
  }
  return out;
}

// ---------- 差异图生成（整图一次算好，之后按普通图绘制；性能结论见 notes/T09.md） ----------

/**
 * 把两张等尺寸的图生成一张差异画布（原图分辨率）。
 * 生成一次后整张缓存，缩放平移走普通 drawImage 路径，交互不重算像素。
 */
export function renderDiffCanvas(
  ref: HTMLImageElement,
  cand: HTMLImageElement,
  threshold: number,
): HTMLCanvasElement | null {
  const w = ref.naturalWidth;
  const h = ref.naturalHeight;
  if (w === 0 || h === 0) return null;
  const grab = (img: HTMLImageElement): ImageData | null => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  };
  const a = grab(ref);
  const b = grab(cand);
  if (!a || !b) return null;
  const data = computeDiffData(a, b, threshold);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  const out = ctx.createImageData(w, h);
  out.data.set(data);
  ctx.putImageData(out, 0, 0);
  return canvas;
}

// ---------- 界面状态与控件（状态由查看器按评测轮持有并传入：切标签保留、互不串扰） ----------

export const BLINK_INTERVAL_MS = 500;

/** T09 三种模式的控件状态（T25 第 2 项：从模块级单例改为每评测轮一份，由查看器状态持有） */
export interface CompareUiState {
  /** 叠加模式：跑分图叠加不透明度 0~1（默认 50%） */
  opacity: number;
  /** 差异模式：亮度差阈值（0~255 里的实用区间取 0~100，默认 24） */
  threshold: number;
  /** 闪烁模式：是否自动交替（暂停后仍可手动切换） */
  blinkPlaying: boolean;
  /** 闪烁模式：当前显示的是不是原图 */
  blinkShowingRef: boolean;
}

/** 新评测轮的控件默认值（每轮首次进入时取一份） */
export function defaultCompareUi(): CompareUiState {
  return {
    opacity: 0.5,
    threshold: 24,
    blinkPlaying: true,
    blinkShowingRef: false,
  };
}

// 闪烁定时器（模块级：同一时刻最多一个；mountViewer 重挂/离开模式时必须 stopBlink）
let blinkTimer: ReturnType<typeof setInterval> | null = null;

/** 每隔固定间隔把显示内容翻面一次；调用方负责先 stopBlink 防止重复定时器 */
export function startBlink(onFlip: () => void): void {
  stopBlink();
  blinkTimer = setInterval(onFlip, BLINK_INTERVAL_MS);
}

export function stopBlink(): void {
  if (blinkTimer !== null) {
    clearInterval(blinkTimer);
    blinkTimer = null;
  }
}

/**
 * 构建 T09 模式的工具条控件（叠加滑杆 / 阈值滑杆 / 闪烁按钮）。ui 是该评测轮的控件状态
 * （viewer.ts 按轮持有），控件读写它、不自己存；onChange 在任一控件改动后回调
 * （viewer.ts 里用于 scheduleDraw）。
 */
export function buildT09Controls(
  mode: 'overlay' | 'diff' | 'blink',
  ui: CompareUiState,
  onChange: () => void,
): HTMLElement {
  const box = document.createElement('span');
  box.className = 'viewer-extra';

  if (mode === 'overlay') {
    const label = document.createElement('label');
    label.textContent = '不透明度';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(Math.round(ui.opacity * 100));
    slider.title = '跑分图叠在原图上的不透明度';
    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = `${slider.value}%`;
    slider.addEventListener('input', () => {
      ui.opacity = Number(slider.value) / 100;
      value.textContent = `${slider.value}%`;
      onChange();
    });
    label.append(slider, value);
    box.append(label);
    return box;
  }

  if (mode === 'diff') {
    const label = document.createElement('label');
    label.textContent = '差异阈值';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = String(ui.threshold);
    slider.title = '亮度差超过该值（0~255）的像素标为红/黄热区；调小更敏感';
    const value = document.createElement('span');
    value.className = 'value';
    value.textContent = slider.value;
    slider.addEventListener('input', () => {
      ui.threshold = Number(slider.value);
      value.textContent = slider.value;
      onChange();
    });
    label.append(slider, value);
    box.append(label);
    return box;
  }

  // blink：自动交替（500ms）+ 手动切换。播放中点「暂停」停表；暂停时可手动翻面
  const playBtn = document.createElement('button');
  playBtn.type = 'button';
  playBtn.textContent = ui.blinkPlaying ? '暂停' : '播放';
  playBtn.title = '自动交替显示原图与跑分图（500ms）';
  playBtn.addEventListener('click', () => {
    ui.blinkPlaying = !ui.blinkPlaying;
    playBtn.textContent = ui.blinkPlaying ? '暂停' : '播放';
    onChange();
  });

  const flipBtn = document.createElement('button');
  flipBtn.type = 'button';
  flipBtn.textContent = '手动切换';
  flipBtn.title = '立刻翻到另一张';
  flipBtn.addEventListener('click', () => {
    ui.blinkShowingRef = !ui.blinkShowingRef;
    onChange();
  });

  box.append(playBtn, flipBtn);
  return box;
}
