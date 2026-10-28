// 视频错误文案守卫：MediaError 四类映射、流地址失败、ffprobe 降级提示。

import { describe, expect, it } from 'vitest';
import {
  probeFailureHint,
  probeUnavailableHint,
  streamErrorMessage,
  videoLoadErrorMessage,
} from './errors';

describe('videoLoadErrorMessage', () => {
  it('code 2 指向文件（可能被移动/删除），不甩锅给解码器', () => {
    const message = videoLoadErrorMessage(2, '/videos/dis-150k.mp4');
    expect(message).toContain('dis-150k.mp4');
    expect(message).toContain('无法读取');
    expect(message).not.toContain('解码器');
  });

  it('code 3 指向系统解码器并给出例子', () => {
    const message = videoLoadErrorMessage(3, '/videos/a.mkv');
    expect(message).toContain('a.mkv');
    expect(message).toContain('解码器');
  });

  it('code 4 同时提格式与文件被移动（404 与真格式错都可能走到这里）', () => {
    const message = videoLoadErrorMessage(4, '/videos/b.webm');
    expect(message).toContain('b.webm');
    expect(message).toContain('不是有效的视频文件');
    expect(message).toContain('已被移动');
  });

  it('未知 code 给兜底文案', () => {
    expect(videoLoadErrorMessage(0, '/v/c.mov')).toContain('c.mov');
    expect(videoLoadErrorMessage(99, '/v/c.mov')).toContain('可能不受支持');
  });
});

describe('streamErrorMessage', () => {
  it('保留后端原因，指出是本地流地址失败', () => {
    const message = streamErrorMessage('/videos/a.mp4', '注册失败: 端口未就绪');
    expect(message).toContain('a.mp4');
    expect(message).toContain('流地址获取失败');
    expect(message).toContain('注册失败: 端口未就绪');
  });

  it('非 Error 的抛出也能读成文本', () => {
    expect(streamErrorMessage('/v/a.mp4', 'boom')).toContain('boom');
  });
});

describe('probeUnavailableHint / probeFailureHint', () => {
  it('提示去哪儿补 ffprobe', () => {
    const hint = probeUnavailableHint();
    expect(hint).toContain('ffprobe');
    expect(hint).toContain('设置');
  });

  it('探测失败附上后端原因', () => {
    expect(probeFailureHint('ffprobe 未配置')).toContain('ffprobe 未配置');
  });
});
