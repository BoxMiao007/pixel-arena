// 16px 线性图标（24 视框、stroke 1.5、圆角端点）。全部装饰性：调用方负责
// aria-hidden（本模块默认加）与可访问名（按钮的 aria-label / tooltip 文案）。

const NS = 'http://www.w3.org/2000/svg';

/** 图标名 → path 的 d 属性列表（一个图标可含多段）。 */
const PATHS = {
  image: [
    'M3.5 5h17v14h-17z',
    'M3.5 15.5 9 10.5l4 3.5 3-2.5 4.5 4',
    'M8.5 9.5a1.2 1.2 0 1 0 0-.01',
  ],
  film: ['M3.5 4.5h17v15h-17z', 'M7.5 4.5v15', 'M16.5 4.5v15', 'M3.5 9.5H7M3.5 14.5H7', 'M16.5 9.5h4M16.5 14.5h4'],
  plus: ['M12 5v14', 'M5 12h14'],
  close: ['M6 6l12 12', 'M18 6 6 18'],
  chevronDown: ['m6 9.5 6 6 6-6'],
  chevronRight: ['m9.5 6 6 6-6 6'],
  chevronUp: ['m6 14.5 6-6 6 6'],
  settings: [
    'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z',
    'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  ],
  export: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 16v3.5h16V16'],
  importFile: ['M12 4v12', 'M7 11l5 5 5-5', 'M4 20h16'],
  trash: ['M4 7h16', 'M9.5 7V4.5h5V7', 'M6.5 7l1 13h9l1-13', 'M10.5 11v6', 'M13.5 11v6'],
  refresh: ['M20 12a8 8 0 1 1-2.4-5.7', 'M20 4.5V9h-4.5'],
  folder: ['M3.5 8V6a1 1 0 0 1 1-1h4.5l2 2h8a1 1 0 0 1 1 1v1', 'M3.5 8h17l-1.8 10h-13.4z'],
  split: ['M3.5 4.5h17v15h-17z', 'M12 4.5v15'],
  compare: ['M3.5 4.5h17v15h-17z', 'M9 4.5v15', 'M9 12a1.5 1.5 0 1 0 0-.01'],
  layers: ['m12 3.5 8.5 4.5-8.5 4.5L3.5 8z', 'm3.5 12.5 8.5 4.5 8.5-4.5'],
  diff: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 3.5v17', 'M12 8h4', 'M12 12h5', 'M12 16h3'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M14.5 12a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z'],
  grid: ['M3.5 3.5h7v7h-7z', 'M13.5 3.5h7v7h-7z', 'M3.5 13.5h7v7h-7z', 'M13.5 13.5h7v7h-7z'],
  zoomIn: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'm20.5 20.5-4.5-4.5', 'M8 11h6', 'M11 8v6'],
  zoomOut: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'm20.5 20.5-4.5-4.5', 'M8 11h6'],
  fit: ['M4 9V4h5', 'M20 15v5h-5', 'M20 9V4h-5', 'M4 15v5h5'],
  keyboard: ['M3 6.5h18v11H3z', 'M6.5 10h.01', 'M10 10h.01', 'M13.5 10h.01', 'M17 10h.01', 'M7.5 13.5h9'],
  check: ['m4.5 12.5 5 5 10-11'],
  alert: ['M12 3.5 21 20H3z', 'M12 9.5v4.5', 'M12 17h.01'],
  info: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 11v5.5', 'M12 8h.01'],
  copy: ['M9 9h11v11H9z', 'M5.5 15H4V4h11v1.5'],
  play: ['m8 5 11 7-11 7z'],
  pause: ['M9 5v14', 'M15 5v14'],
  stepBack: ['M6 5v14', 'm18 5-7 7 7 7z'],
  stepForward: ['M18 5v14', 'm6 5 7 7-7 7z'],
  panelLeft: ['M3.5 4.5h17v15h-17z', 'M9 4.5v15'],
  panelRight: ['M3.5 4.5h17v15h-17z', 'M15 4.5v15'],
  panelBottom: ['M3.5 4.5h17v15h-17z', 'M3.5 15h17'],
  expand: ['M4 9V4h5', 'M20 15v5h-5', 'M20 9V4h-5', 'M4 15v5h5', 'M9 4h5', 'M15 20h-5'],
  collapse: ['M9 4v5H4', 'M15 20v-5h5', 'M15 4v5h5', 'M9 20v-5H4'],
  more: ['M6 12h.01', 'M12 12h.01', 'M18 12h.01'],
  pencil: ['M16.5 3.5a2.5 2.5 0 0 1 3.5 3.5L7 20l-4.5 1L3.5 16z'],
  file: ['M14 3.5H6.5v17h11v-13z', 'M14 3.5v4.5h4.5', 'M9 12.5h6', 'M9 16.5h4'],
  gauge: ['M4 18a8 8 0 1 1 16 0', 'M12 18l4-6'],
  clock: ['M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17z', 'M12 7.5V12l3 2'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M10 6H5.5v12.5H18V14'],
  dot: ['M12 12h.01'],
  ruler: ['M3.5 9 9 3.5 20.5 15 15 20.5z', 'M7 11.5l2 2', 'M10 8.5l2 2', 'M13 5.5l2 2'],
  splitVertical: ['M3.5 4.5h17v15h-17z', 'M12 4.5v15', 'M9.5 9.5 6.5 12l3 2.5', 'M14.5 9.5l3 2.5-3 2.5'],
} as const;

export type IconName = keyof typeof PATHS;

/** 建一个 16px 图标；className 追加到 svg 上便于局部改尺寸或颜色。 */
export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', className);
  for (const d of PATHS[name]) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}
