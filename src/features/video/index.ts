// 视频域注册入口：舞台 / 检视器分区 / 结果坞页签 / 命令 / 舞台键位。
//
// 由 boot.ts 以副作用方式 import 一次；本模块不做任何渲染，只声明契约。
// 键位由 shell/registry 统一派发（输入框与浮层打开时不派发）；外壳的全局组合键
// （Ctrl+O / Ctrl+Shift+O / Ctrl+Enter）按 id 直接命中这里的命令。

import { onGroupRemoved } from '../../core/actions';
import { activeRound } from '../../core/model';
import { getState, isBusy } from '../../core/store';
import { isTypingTarget } from '../../ui/dom';
import {
  registerCommand,
  registerDockTab,
  registerKeyBinding,
  registerPanelSection,
  registerStageView,
} from '../../shell/registry';
import {
  pickVideoCandidatesForActiveRound,
  pickVideoReferenceForActiveRound,
  runVideoScoringForActiveRound,
} from './actions';
import { dropSession } from './advanced/catalog';
import { openAdvancedVideoPanel } from './advanced/panel';
import { mountVideoMetricsTab } from './dock';
import { mountAdvancedVideoSection } from './inspector/advanced';
import { mountCandidatesPanel } from './inspector/candidates';
import { mountReferencePanel } from './inspector/reference';
import { mountRoundNoteSection } from './inspector/round-note';
import { mountScoringPanel } from './inspector/scoring';
import { activeVideoCommands, mountVideoStage, type VideoStageMode } from './stage';

// ---------- 舞台与分区 ----------

registerStageView({
  id: 'video-viewer',
  label: '视频对比',
  kinds: ['video'],
  mount: mountVideoStage,
});

registerPanelSection({
  id: 'round-note',
  title: '本轮备注',
  order: 5,
  // 轮备注是跨域数据（图片组也会有），两个组类型都展示；空备注时分区不出现。
  kinds: ['image', 'video'],
  mount: mountRoundNoteSection,
});

registerPanelSection({
  id: 'reference-video',
  title: '原视频',
  order: 10,
  kinds: ['video'],
  mount: mountReferencePanel,
});

registerPanelSection({
  id: 'candidates-video',
  title: '跑分视频',
  order: 20,
  kinds: ['video'],
  mount: mountCandidatesPanel,
});

registerPanelSection({
  id: 'score-video',
  title: '视频跑分',
  order: 30,
  kinds: ['video'],
  mount: mountScoringPanel,
});

registerPanelSection({
  id: 'advanced-video',
  title: '高级',
  order: 50,
  kinds: ['video'],
  mount: mountAdvancedVideoSection,
});

registerDockTab({
  id: 'video-metrics',
  label: '视频指标',
  order: 40,
  kinds: ['video'],
  mount: mountVideoMetricsTab,
});

// ---------- 命令（快捷键与按钮共用） ----------

registerCommand({
  id: 'pick-reference-video',
  run: () => pickVideoReferenceForActiveRound(),
});

registerCommand({
  id: 'pick-candidates-video',
  run: () => pickVideoCandidatesForActiveRound(),
});

registerCommand({
  id: 'run-score-video',
  run: () => runVideoScoringForActiveRound(),
});

// 高级创建（视频）：检视器「高级」分区的按钮经 runCommand 调用；打开面板做
// 编码器选择 / 参数配置 / 命令行预览，确认后建轮 + 写轮备注（不自动编码）。
registerCommand({
  id: 'advanced-video-create',
  enabled: () => !isBusy(),
  run: () => {
    const session = activeRound(getState().workspace);
    if (!session || session.group.kind !== 'video') return;
    openAdvancedVideoPanel(session.group.id, session.round.id);
  },
});

// 跑分组关闭：丢弃该组的高级创建会话（组 id 不复用，留着只会白占内存）
onGroupRemoved((groupId) => dropSession(groupId));

// ---------- 舞台键位 ----------
//
// 只在视频舞台挂载时生效；输入框/下拉/按钮上的按键不抢（空格要留给按钮激活）。
// Shift 由 run(event) 内部分流：外壳的键位匹配只有 event.key，没有 "Shift+ArrowLeft"。
// Home/End / 1-3 / +/-/0 与图片查看器同一套心智（kinds 过滤，互不干扰）。

function stageReady(): boolean {
  return activeVideoCommands() !== null;
}

function focusNotTyping(): boolean {
  return !isTypingTarget(document.activeElement);
}

function focusNotButton(): boolean {
  const active = document.activeElement;
  return !(active instanceof HTMLButtonElement) && !(active instanceof HTMLAnchorElement);
}

function whenStage(): boolean {
  return stageReady() && focusNotTyping();
}

const MODE_KEYS: Record<string, VideoStageMode> = {
  '1': 'split',
  '2': 'slider',
  '3': 'grid',
};

registerKeyBinding({
  id: 'video-step-frame',
  keys: ['ArrowLeft', 'ArrowRight'],
  kinds: ['video'],
  when: whenStage,
  run: (event) => {
    const commands = activeVideoCommands();
    if (!commands) return;
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    // Shift = 一次 10 帧（旧界面的 ±1 帧按钮保留，这里是键盘的快捷档）
    commands.step(direction * (event.shiftKey ? 10 : 1));
  },
});

registerKeyBinding({
  id: 'video-jump-edge',
  keys: ['Home', 'End'],
  kinds: ['video'],
  when: whenStage,
  run: (event) => {
    const commands = activeVideoCommands();
    if (!commands) return;
    event.preventDefault();
    if (event.key === 'Home') commands.first();
    else commands.last();
  },
});

registerKeyBinding({
  id: 'video-play-toggle',
  keys: [' '],
  kinds: ['video'],
  when: () => whenStage() && focusNotButton(),
  run: (event) => {
    const commands = activeVideoCommands();
    if (!commands) return;
    event.preventDefault();
    commands.togglePlay();
  },
});

registerKeyBinding({
  id: 'video-mode',
  keys: ['1', '2', '3'],
  kinds: ['video'],
  when: whenStage,
  run: (event) => {
    const commands = activeVideoCommands();
    const mode = MODE_KEYS[event.key];
    if (!commands || !mode) return;
    event.preventDefault();
    commands.setMode(mode);
  },
});

registerKeyBinding({
  id: 'video-zoom-in',
  keys: ['+', '=', 'Add'],
  kinds: ['video'],
  when: whenStage,
  run: (event) => {
    const commands = activeVideoCommands();
    if (!commands) return;
    event.preventDefault();
    commands.zoomIn();
  },
});

registerKeyBinding({
  id: 'video-zoom-out',
  keys: ['-', '_', 'Subtract'],
  kinds: ['video'],
  when: whenStage,
  run: (event) => {
    const commands = activeVideoCommands();
    if (!commands) return;
    event.preventDefault();
    commands.zoomOut();
  },
});

registerKeyBinding({
  id: 'video-zoom-fit',
  keys: ['0'],
  kinds: ['video'],
  when: whenStage,
  run: (event) => {
    const commands = activeVideoCommands();
    if (!commands) return;
    event.preventDefault();
    commands.fit();
  },
});
