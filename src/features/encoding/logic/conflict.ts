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
