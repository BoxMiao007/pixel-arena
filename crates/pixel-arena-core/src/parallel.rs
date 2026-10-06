//! 并行调度（T24）：整轮跑分的通用调度函数，GUI 与 CLI 共用。
//!
//! 刻意不用 rayon：调度需求只有「固定并发上限 + 保序结果 + 进度回调」，
//! 一个 std::thread::scope 的工作池就够（KISS），少拉一棵依赖树。并发上限来自
//! 设置的四档比例（1/4、1/2、3/4、全部，默认 1/2），换算规则在本模块，
//! 设置枚举留在 GUI 壳层（CLI 不读 GUI 设置，见决策 0005 的结构约束）。

/// 逻辑核心数。`available_parallelism` 已考虑 cgroup 配额等；拿不到时按 1 兜底。
pub fn logical_cores() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

/// 按比例换算并发上限：floor(逻辑核数 × fraction)，夹在 [1, 逻辑核数]。
/// 「默认只用一半核心留余量」由此保证——偶数核减半，奇数核向下取整。
pub fn concurrency_limit(fraction: f64) -> usize {
    let cores = logical_cores();
    let scaled = (cores as f64 * fraction).floor() as usize;
    scaled.clamp(1, cores)
}

/// 有序并行调度：对每个元素调用 `job`，最多 `max_concurrency` 个同时执行，
/// 结果按输入顺序返回（跑分行与选入顺序一一对应靠它保证）。每完成一个，
/// 以「已完成数」回调一次 `on_progress`（跨线程共享，回调自身要考虑并发）。
///
/// `max_concurrency` 会被夹到至少 1；空列表直接返回空结果。
pub fn run_parallel<T, R, F, P>(items: &[T], max_concurrency: usize, job: F, on_progress: P) -> Vec<R>
where
    T: Sync,
    R: Send,
    F: Fn(&T) -> R + Sync,
    P: Fn(usize) + Sync,
{
    if items.is_empty() {
        return Vec::new();
    }
    let workers = max_concurrency.max(1).min(items.len());
    let next_index = std::sync::atomic::AtomicUsize::new(0);
    // 进度计数走互斥锁而非原子量：把「自增 + 回调」绑成一段，保证回调看到的
    // 已完成数单调递增（进度条不能往回跳）；临界区只有一次回调，开销可忽略
    let progress: std::sync::Mutex<usize> = std::sync::Mutex::new(0);
    // 结果先落各自槽位再统一按序取出：完成顺序不影响最终顺序
    let slots: Vec<std::sync::Mutex<Option<R>>> = (0..items.len()).map(|_| std::sync::Mutex::new(None)).collect();

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let index = next_index.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if index >= items.len() {
                    break;
                }
                let result = job(&items[index]);
                *slots[index].lock().expect("结果槽锁不应中毒") = Some(result);
                let mut done = progress.lock().expect("进度锁不应中毒");
                *done += 1;
                on_progress(*done);
            });
        }
    });

    slots
        .into_iter()
        .map(|slot| slot.into_inner().expect("结果槽锁不应中毒").expect("每个槽位都应被写入"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    #[test]
    fn 并发上限_按比例换算并夹取() {
        // 换算规则直接锚定典型核数，防止实现漂移
        assert_eq!(concurrency_from(8, 0.5), 4, "8 核的一半 = 4");
        assert_eq!(concurrency_from(5, 0.5), 2, "5 核的一半向下取整 = 2");
        assert_eq!(concurrency_from(4, 0.25), 1, "4 核的 1/4 = 1");
        assert_eq!(concurrency_from(4, 0.75), 3, "4 核的 3/4 = 3");
        assert_eq!(concurrency_from(4, 1.0), 4, "全部 = 核数本身");
        assert_eq!(concurrency_from(1, 0.25), 1, "单核任何档都至少 1");
    }

    /// 与 concurrency_limit 相同的换算，但核数由测试给定（不依赖本机核数）。
    fn concurrency_from(cores: usize, fraction: f64) -> usize {
        let scaled = (cores as f64 * fraction).floor() as usize;
        scaled.clamp(1, cores)
    }

    #[test]
    fn 本机并发上限_落在合理区间() {
        let cores = logical_cores();
        assert!(cores >= 1);
        let half = concurrency_limit(0.5);
        assert!(
            half >= 1 && half <= cores,
            "默认档应夹在 [1, {cores}]，实际 {half}"
        );
        assert_eq!(concurrency_limit(1.0), cores, "全部档 = 本机逻辑核数");
    }

    #[test]
    fn 结果保序_与输入顺序一致() {
        let items: Vec<u32> = (0..50).collect();
        let results = run_parallel(&items, 4, |x| x * 2, |_| {});
        assert_eq!(results, items.iter().map(|x| x * 2).collect::<Vec<_>>());
    }

    #[test]
    fn 并发数超过元素个数_不空转_结果仍全对() {
        let items = [1, 2, 3];
        let results = run_parallel(&items, 100, |x| x + 1, |_| {});
        assert_eq!(results, vec![2, 3, 4]);
    }

    #[test]
    fn 空列表_返回空结果且不起线程() {
        let items: Vec<u32> = Vec::new();
        let results: Vec<u32> = run_parallel(&items, 4, |x| x + 1, |_| {});
        assert!(results.is_empty());
    }

    #[test]
    fn 并发零_夹到一仍能跑完() {
        let items = [10, 20];
        let results = run_parallel(&items, 0, |x| x - 1, |_| {});
        assert_eq!(results, vec![9, 19]);
    }

    #[test]
    fn 进度回调_每个元素完成时恰好一次_单调到总数() {
        let items: Vec<u32> = (0..24).collect();
        let max_seen = AtomicUsize::new(0);
        let calls = AtomicUsize::new(0);
        run_parallel(
            &items,
            6,
            |x| {
                // 模拟不均负载，完成顺序交错
                std::thread::sleep(std::time::Duration::from_millis(*x as u64 % 3));
                x + 1
            },
            |done| {
                calls.fetch_add(1, Ordering::SeqCst);
                max_seen.fetch_max(done, Ordering::SeqCst);
            },
        );
        assert_eq!(calls.load(Ordering::SeqCst), 24, "每元素恰好回调一次");
        assert_eq!(max_seen.load(Ordering::SeqCst), 24, "最后一次应报到总数");
    }

    #[test]
    fn 实际同时运行的线程数_不超过上限() {
        // 在任务体内计数同时在场数：进 +1、出 -1，峰值不得越过 max_concurrency
        let items: Vec<u32> = (0..32).collect();
        let in_flight = AtomicUsize::new(0);
        let peak = AtomicUsize::new(0);
        let gate = Mutex::new(());
        run_parallel(
            &items,
            3,
            |x| {
                // 计数段串行化（保 fetch_add/fetch_max 原子组合成「进」），睡 2ms 模拟负载
                let guard = gate.lock().expect("计数锁不应中毒");
                let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                drop(guard);
                std::thread::sleep(std::time::Duration::from_millis(2));
                in_flight.fetch_sub(1, Ordering::SeqCst);
                *x
            },
            |_| {},
        );
        assert!(
            peak.load(Ordering::SeqCst) <= 3,
            "峰值并发 {} 超过了上限 3",
            peak.load(Ordering::SeqCst)
        );
    }
}
