// 冲突询问状态机（T30）的单测：期望值来自票面语义的字面推演
// （「应用到本次全部冲突」后剩余冲突不再打扰），不依赖 DOM。

import { describe, it, expect } from 'vitest';
import { ConflictSession, type ConflictAnswer } from './conflict';

/** 按预置回答序列依次弹窗的 asker，记录每次实际被问到的文件名。 */
function scriptedAsker(answers: ConflictAnswer[]) {
  const asked: string[] = [];
  const ask = (fileName: string): Promise<ConflictAnswer> => {
    asked.push(fileName);
    const answer = answers[asked.length - 1];
    if (answer === undefined) throw new Error(`不该再问：${fileName}`);
    return Promise.resolve(answer);
  };
  return { ask, asked };
}

describe('ConflictSession（冲突决策状态机）', () => {
  it('无批量决定时逐个弹窗，单独决定只影响当前冲突项', async () => {
    const { ask, asked } = scriptedAsker(['overwrite', 'skip']);
    const session = new ConflictSession(ask);
    expect(await session.decide('a.jpg')).toBe('overwrite');
    expect(await session.decide('b.jpg')).toBe('skip');
    expect(asked).toEqual(['a.jpg', 'b.jpg']);
  });

  it('选「覆盖全部」后：当前项覆盖，剩余冲突不再弹窗、直接覆盖', async () => {
    const { ask, asked } = scriptedAsker(['overwrite-all']);
    const session = new ConflictSession(ask);
    expect(await session.decide('a.jpg')).toBe('overwrite');
    expect(await session.decide('b.jpg')).toBe('overwrite');
    expect(await session.decide('c.jpg')).toBe('overwrite');
    expect(asked).toEqual(['a.jpg']);
  });

  it('选「跳过全部」后：剩余冲突直接跳过', async () => {
    const { ask, asked } = scriptedAsker(['skip-all']);
    const session = new ConflictSession(ask);
    expect(await session.decide('a.jpg')).toBe('skip');
    expect(await session.decide('b.jpg')).toBe('skip');
    expect(asked).toEqual(['a.jpg']);
  });

  it('peekBatchDecision：选过「全部」返回已选动作，未选返回 null', async () => {
    const { ask } = scriptedAsker(['overwrite-all']);
    const session = new ConflictSession(ask);
    expect(session.peekBatchDecision()).toBeNull();
    await session.decide('a.jpg');
    expect(session.peekBatchDecision()).toBe('overwrite');
  });
});
