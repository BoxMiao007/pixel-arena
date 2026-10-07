// 产物文件名冲突询问（T30）：设置策略为「询问」时，跑分产物写入前探测到同名
// 冲突由本模块弹窗拍板。两层：
// - ConflictSession：一批产物生成的决策状态机（纯逻辑，vitest 可测）——
//   「应用到本次全部冲突」后剩余冲突按已选动作自动处理，不再弹窗（票面验收 3）；
// - askFileConflict：覆盖层弹窗（复用设置面板的 settings-* 视觉），四个按钮
//  「覆盖 / 跳过 / 覆盖全部 / 跳过全部」一一对应票面的「覆盖/跳过 + 当前项/全部」。
//
// 协议（与 src-tauri 的 onestop_encode / advanced_encode 回包对应）：
// 后端回 conflict 时未写入任何文件；「覆盖」带 conflictDecision:"overwrite" 重调，
// 「跳过」不再重调——该产物不生成、不进轮。

/** 对单个冲突的决定：覆盖 = 用确切名落位覆盖；跳过 = 放弃该产物。 */
export type ConflictDecision = 'overwrite' | 'skip';

/** 弹窗回传：单独决定，或「应用到本次全部冲突」的批量决定。 */
export type ConflictAnswer = ConflictDecision | 'overwrite-all' | 'skip-all';

/** 一批产物生成（一次一站式跑分 / 一次高级创建批量）的冲突决策会话：
 * 首个「覆盖全部/跳过全部」后记忆决定，剩余冲突不再询问。会话随批次创建，
 * 不跨批次（「本次全部」的边界）。 */
export class ConflictSession {
  private all: ConflictDecision | null = null;

  constructor(private readonly ask: (fileName: string) => Promise<ConflictAnswer>) {}

  /** 目标名与已有文件冲突时取决定（无历史批量决定才弹窗）。 */
  async decide(fileName: string): Promise<ConflictDecision> {
    if (this.all) return this.all;
    const answer = await this.ask(fileName);
    if (answer === 'overwrite-all') {
      this.all = 'overwrite';
      return 'overwrite';
    }
    if (answer === 'skip-all') {
      this.all = 'skip';
      return 'skip';
    }
    return answer;
  }

  /** 已有批量决定时（选过「全部」）直接给决定；没有则 null（需要弹窗）。 */
  peekBatchDecision(): ConflictDecision | null {
    return this.all;
  }
}

/** 冲突询问弹窗（挂 body 的覆盖层，拍板即销毁）：显示冲突文件名，四个按钮
 * 返回对应 ConflictAnswer。纯前端交互，不涉及 IPC。 */
export function askFileConflict(fileName: string): Promise<ConflictAnswer> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay conflict-overlay';
    const panel = document.createElement('div');
    panel.className = 'settings-panel conflict-panel';
    const title = document.createElement('h2');
    title.textContent = '文件名冲突';
    const message = document.createElement('p');
    message.className = 'conflict-message';
    message.textContent = `产物 ${fileName} 已存在于产物目录（Pixel Arena）。要覆盖它，还是跳过这项？`;
    const actions = document.createElement('div');
    actions.className = 'conflict-actions';

    const done = (answer: ConflictAnswer): void => {
      overlay.remove();
      resolve(answer);
    };
    const button = (label: string, answer: ConflictAnswer, primary: boolean): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.className = primary ? 'settings-primary-btn' : 'settings-mini-btn';
      btn.textContent = label;
      btn.addEventListener('click', () => done(answer));
      return btn;
    };
    actions.append(
      button('覆盖', 'overwrite', true),
      button('跳过', 'skip', false),
      button('覆盖全部', 'overwrite-all', false),
      button('跳过全部', 'skip-all', false),
    );

    panel.append(title, message, actions);
    overlay.append(panel);
    document.body.append(overlay);
  });
}
