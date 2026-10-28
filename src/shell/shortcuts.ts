// 全局快捷键：模态浮层与输入框优先，其次功能域注册的键位，最后外壳自己的组合键。
//
// 只做分发，不含业务：具体动作都走 registry 的命令或 key binding。

import { getState } from '../core/store';
import { activeRound } from '../core/model';
import { isTypingTarget } from '../ui/dom';
import { overlayOpen } from '../ui/overlay';
import { activateGroup, createGroup, createRound } from '../core/actions';
import { focusDockTab } from './regions';
import { exitImmersive, toggleImmersive, togglePanel } from './controller';
import { keyBindingsSnapshot, runCommand, runKindCommand } from './registry';

/** 归一化按键：单个字符统一小写（1–6、空格、+、-、0、?），其余原样。 */
function keyOf(event: KeyboardEvent): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

function groupOf(): { kind: 'image' | 'video' } | null {
  const session = activeRound(getState().workspace);
  return session ? { kind: session.group.kind } : null;
}

export function installShortcuts(): void {
  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;

    // 浮层自己处理 Esc / Tab / 方向键，但 Ctrl 组合键仍然放行给外壳。
    const mod = event.ctrlKey || event.metaKey;
    if (!mod && overlayOpen()) return;

    if (isTypingTarget(event.target)) {
      // 输入框内只保留 Esc（交给浮层或退出沉浸）
      if (event.key === 'Escape' && !overlayOpen()) exitImmersive();
      return;
    }

    const session = groupOf();
    const kind = session?.kind;

    if (mod) {
      const key = event.key.toLowerCase();
      // Ctrl+1…9 切换跑分组
      if (/^[1-9]$/.test(event.key)) {
        const groups = getState().workspace?.groups ?? [];
        const target = groups[Number(event.key) - 1];
        if (target) {
          event.preventDefault();
          void activateGroup(target);
        }
        return;
      }
      switch (key) {
        case 'n': {
          event.preventDefault();
          if (event.shiftKey) {
            void createGroup(kind === 'video' ? 'video' : 'image');
          } else {
            const workspace = getState().workspace;
            const group = workspace?.groups.find((item) => item.id === workspace.activeGroupId);
            if (group) void createRound(group);
          }
          return;
        }
        case 'o': {
          event.preventDefault();
          if (!kind) return;
          void runKindCommand(event.shiftKey ? 'pick-candidates' : 'pick-reference', kind);
          return;
        }
        case 'enter': {
          event.preventDefault();
          if (!kind) return;
          void runKindCommand('run-score', kind);
          return;
        }
        case 'e': {
          event.preventDefault();
          void runCommand('export-menu');
          return;
        }
        case ',': {
          event.preventDefault();
          void runCommand('open-settings');
          return;
        }
        case 'b': {
          event.preventDefault();
          togglePanel('rail');
          return;
        }
        case 'i': {
          event.preventDefault();
          togglePanel('inspector');
          return;
        }
        case 'j': {
          event.preventDefault();
          togglePanel('dock');
          return;
        }
        case 'f': {
          event.preventDefault();
          toggleImmersive();
          return;
        }
        default:
          return;
      }
    }

    // ---- 无修饰键：先给功能域（查看器 1–6、空格、+/-、0；视频 ←/→） ----
    if (kind) {
      for (const binding of keyBindingsSnapshot()) {
        if (binding.kinds && !binding.kinds.includes(kind)) continue;
        if (binding.when && !binding.when()) continue;
        if (!binding.keys.includes(keyOf(event))) continue;
        event.preventDefault();
        binding.run(event);
        return;
      }
    }

    // ---- 外壳自己的无修饰键 ----
    if (event.key === 'Escape') {
      // 浮层打开时它的 capture 监听已经处理并阻止冒泡，这里只剩「退出沉浸」
      exitImmersive();
      return;
    }
    if (event.key === '?') {
      event.preventDefault();
      void runCommand('open-help');
      return;
    }
    if (keyOf(event) === 'f') {
      event.preventDefault();
      toggleImmersive();
    }
  });
}

/** 打开某个结果坞页签（供功能域在动作完成后跳转）。 */
export function showDockTab(id: string): void {
  focusDockTab(id);
}
