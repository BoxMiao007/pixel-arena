// 入口：经 Tauri IPC 从 Rust 侧取回核心库版本并显示。
// 这是「前端 -> IPC -> Rust 核心库」第一条贯通路径的窗口侧证明；
// 对比查看器等界面能力在后续票实现，本文件保持最小。

import { invoke } from '@tauri-apps/api/core';
import './style.css';

async function showCoreVersion(): Promise<void> {
  const el = document.querySelector('#core-version');
  if (!el) return;
  try {
    const version = await invoke<string>('core_version');
    el.textContent = `核心库版本 v${version}（经 IPC 取回）`;
  } catch (err) {
    // 失败时把原因写到页面上，便于在窗口里直接定位 IPC 问题
    el.textContent = `IPC 调用失败: ${String(err)}`;
  }
}

showCoreVersion();
