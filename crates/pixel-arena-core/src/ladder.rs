// 编码阶梯取点（T21 单源化）：GUI 与 CLI 共用的两套取点逻辑的唯一实现。
//
// 质量优先：统一基准值 0–100 → 按各格式自身参数范围映射，每个有损格式在基准附近
// 自动取 ≥3 个质量点（决策 0003 默认阶梯 60/75/90 即基准 75 的取点结果），并固定
// 追加无损对照组 PNG/无损 WebP/无损 JXL。
// 大小优先：目标字节数 → 每格式用注入的「质量 → 实际大小」探测回调搜索逼近，
// 不可达（过小压不到 / 过大放松到顶）回退最接近点并携带标注。
//
// 本模块保持纯函数：真实编码动作由调用方以探测回调注入（encode.rs 的
// probe_onestop_size 提供现成实现），脱离真实编码器可单测。

use crate::encode::OnestopFormat;
use crate::error::CoreError;

/// 有损格式的规范顺序（= 默认生成顺序，决策 0003，与前端 onestop.ts 的清单同步）。
pub const LOSSY_FORMATS: [OnestopFormat; 4] = [
    OnestopFormat::Jpeg,
    OnestopFormat::Webp,
    OnestopFormat::Avif,
    OnestopFormat::Jxl,
];

/// 无损对照组的规范顺序（像素与原图逐位一致，核心库保证）。
pub const LOSSLESS_FORMATS: [OnestopFormat; 3] = [
    OnestopFormat::Png,
    OnestopFormat::WebpLossless,
    OnestopFormat::JxlLossless,
];

/// 编码阶梯的一项：一个待生成的档位（格式 + 质量 + 进度显示名）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LadderItem {
    /// 规范格式字符串（jpeg/webp/avif/jxl/png/webp-lossless/jxl-lossless）。
    pub format: String,
    /// 无损组为 None。
    pub quality: Option<u8>,
    /// 进度显示名：「JPEG q60」「无损 WebP」。
    pub label: String,
}

impl LadderItem {
    /// 从格式与质量构造档位项。label 是单一来源：有损 = encoding_params_text
    ///（「JPEG q60」式），无损 = display_name（「无损 WebP」式），与现行口径逐字一致。
    pub fn new(format: OnestopFormat, quality: Option<u8>) -> Self {
        LadderItem {
            format: format.as_str().to_string(),
            quality,
            label: match quality {
                Some(q) => format.encoding_params_text(Some(q)),
                None => format.display_name().to_string(),
            },
        }
    }
}

/// 各有损格式自身的质量参数有效范围（统一基准值映射的目标区间）。
/// cjxl 的质量 100 是数学无损（与无损对照组重叠），有损阶梯上限收到 95；
/// 其余编码器 1–100 全程可用（0 由 encode 层 fail-fast，取点不会给出）。
fn quality_range(format: OnestopFormat) -> (u8, u8) {
    match format {
        OnestopFormat::Jxl => (1, 95),
        _ => (1, 100),
    }
}

/// 基准附近的取点偏移：±15 为主（与现行默认阶梯 60/75/90 的间距一致）；
/// 基准贴近格式边界导致不足 3 个不同点时，再向内扩 ±30 补足。
const BASELINE_OFFSETS: [i16; 5] = [-15, 0, 15, -30, 30];

/// 质量优先取点：统一基准值 0–100 映射到单个格式的质量参数序列。
///
/// 在基准 ±15 处取点（含基准本身），越界值夹到格式自身范围内；不同点不足 3 个时
/// 继续取 ±30 直至补足（保证 BD-rate 的率失真曲线有足够样本）。结果升序去重。
pub fn quality_points(baseline: u8, format: OnestopFormat) -> Result<Vec<u8>, CoreError> {
    if baseline > 100 {
        return Err(CoreError::Encode {
            message: format!("基准质量 {baseline} 无效，有效范围 0–100"),
        });
    }
    let (lo, hi) = quality_range(format);
    let mut points: Vec<u8> = Vec::new();
    for offset in BASELINE_OFFSETS {
        let candidate = i16::from(baseline) + offset;
        let candidate = candidate.clamp(i16::from(lo), i16::from(hi)) as u8;
        if !points.contains(&candidate) {
            points.push(candidate);
        }
        if points.len() == 3 {
            break;
        }
    }
    // 格式范围宽度 ≥95、5 个候选偏移覆盖 ±30，任何基准下都必然凑足 3 个不同点
    debug_assert_eq!(points.len(), 3, "取点逻辑应保证每格式 3 点");
    points.sort_unstable();
    Ok(points)
}

/// 质量优先的完整编码阶梯：有损 4 格式 × 各自取点（升序），后接无损对照组。
/// 统一基准 75 的输出与决策 0003 的现行默认阶梯（60/75/90 + 无损组）完全一致。
pub fn quality_ladder(baseline: u8) -> Result<Vec<LadderItem>, CoreError> {
    let mut ladder = Vec::new();
    for format in LOSSY_FORMATS {
        for quality in quality_points(baseline, format)? {
            ladder.push(LadderItem::new(format, Some(quality)));
        }
    }
    for format in LOSSLESS_FORMATS {
        ladder.push(LadderItem::new(format, None));
    }
    Ok(ladder)
}

/// 单点模式阶梯（v0.1.5 反馈：一站式加「单点模式」开关）：每有损格式只压基准
/// 质量 1 点（基准夹到该格式有效范围内，如 JXL 上限 95），无损对照组照常（无损
/// 与质量无关，保持「有损 vs 无损」参照与现行清单口径一致）。取点仍在核心库，
/// 前端不自持档位定义。
pub fn single_point_ladder(baseline: u8) -> Result<Vec<LadderItem>, CoreError> {
    if baseline > 100 {
        return Err(CoreError::Encode {
            message: format!("基准质量 {baseline} 无效，有效范围 0–100"),
        });
    }
    let mut ladder = Vec::new();
    for format in LOSSY_FORMATS {
        let (lo, hi) = quality_range(format);
        let quality = baseline.clamp(lo, hi);
        ladder.push(LadderItem::new(format, Some(quality)));
    }
    for format in LOSSLESS_FORMATS {
        ladder.push(LadderItem::new(format, None));
    }
    Ok(ladder)
}

/// 大小优先的不可达类型：目标落在该格式可达大小范围之外，已回退最接近点。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SizeUnreachable {
    /// 目标过小：连最小质量点的产物都超过目标。
    TargetTooSmall,
    /// 目标过大：连最高质量点的产物都不到目标。
    TargetTooLarge,
}

/// 一个质量点及其探测到的实际产物大小。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SizePoint {
    pub quality: u8,
    pub bytes: u64,
}

/// 大小优先单格式的搜索结果：命中的最接近点 + 邻近补点（率失真样本 ≥3）+ 不可达标注。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SizeSearchResult {
    /// 规范格式字符串。
    pub format: String,
    /// 本次搜索的目标大小（字节），标注文本与界面展示共用。
    pub target_bytes: u64,
    /// 逼近目标选中的质量点（不可达时为最小/最大质量点）。
    pub hit: SizePoint,
    /// None = 目标可达；Some = 不可达的回退类型。
    pub unreachable: Option<SizeUnreachable>,
    /// 命中点及其邻近点（升序 ≥3 点，US23：避免 BD-rate 因单点而「样本不足」），
    /// 每点带探测到的实际大小。
    pub points: Vec<SizePoint>,
}

impl SizeSearchResult {
    /// 不可达标注的中文文本（CLI 结果 note 列与 GUI 提示共用单一来源）；可达时 None。
    pub fn annotation_note(&self) -> Option<String> {
        match self.unreachable? {
            SizeUnreachable::TargetTooSmall => Some(format!(
                "目标 {} 字节过小不可达，已取最接近点 q{}（实际 {} 字节）",
                self.target_bytes, self.hit.quality, self.hit.bytes
            )),
            SizeUnreachable::TargetTooLarge => Some(format!(
                "目标 {} 字节过大不可达，已取最接近点 q{}（实际 {} 字节）",
                self.target_bytes, self.hit.quality, self.hit.bytes
            )),
        }
    }
}

/// 大小优先搜索：在格式的质量范围内寻找产物大小最接近目标的质量点。
///
/// `probe` 由调用方注入「质量 → 实际大小」探测（真实编码器见 encode.rs 的
/// probe_onestop_size），本函数保持纯逻辑、可脱离编码器单测。
///
/// 策略：先探测范围两端定位目标是否可达；可达则二分逼近（依赖「质量越高产物越大」
/// 的总体单调性，局部非单调时结果仍是合理逼近点，不保证全局最优）；两侧等距时取
/// 不超过目标的低质量点。命中后按质量优先的取点规则补邻近点，每点实测大小。
pub fn size_search(
    format: OnestopFormat,
    target_bytes: u64,
    probe: &mut dyn FnMut(u8) -> Result<u64, CoreError>,
) -> Result<SizeSearchResult, CoreError> {
    let (lo, hi) = quality_range(format);
    let size_lo = probe(lo)?;
    let size_hi = probe(hi)?;

    let hit = if size_lo > target_bytes {
        // 过小压不到：最小质量点已是最接近目标的点
        SizePoint {
            quality: lo,
            bytes: size_lo,
        }
    } else if size_hi < target_bytes {
        // 过大放松到顶：最高质量点已是最接近目标的点
        SizePoint {
            quality: hi,
            bytes: size_hi,
        }
    } else {
        // 不变式：size(lo) ≤ target ≤ size(hi)，二分收缩到相邻两点取更接近者
        let (mut a, mut b) = (lo, hi);
        let mut size_a = size_lo;
        let mut size_b = size_hi;
        while b - a > 1 {
            let mid = a + (b - a) / 2;
            let size_mid = probe(mid)?;
            if size_mid <= target_bytes {
                a = mid;
                size_a = size_mid;
            } else {
                b = mid;
                size_b = size_mid;
            }
        }
        if target_bytes - size_a <= size_b - target_bytes {
            SizePoint {
                quality: a,
                bytes: size_a,
            }
        } else {
            SizePoint {
                quality: b,
                bytes: size_b,
            }
        }
    };

    // US23：命中点邻近自动补点（与质量优先同一套取点规则），命中点复用已探测的大小
    let mut points = Vec::new();
    for quality in quality_points(hit.quality, format)? {
        let bytes = if quality == hit.quality {
            hit.bytes
        } else {
            probe(quality)?
        };
        points.push(SizePoint { quality, bytes });
    }

    Ok(SizeSearchResult {
        format: format.as_str().to_string(),
        target_bytes,
        hit,
        unreachable: match hit.quality {
            q if q == lo && size_lo > target_bytes => Some(SizeUnreachable::TargetTooSmall),
            q if q == hi && size_hi < target_bytes => Some(SizeUnreachable::TargetTooLarge),
            _ => None,
        },
        points,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quality_points_基准75_每格式恰为现行默认阶梯60_75_90() {
        // 现行默认阶梯（决策 0003）必须被取点函数原样复现：GUI/CLI 默认行为不变的锚点
        for format in LOSSY_FORMATS {
            assert_eq!(
                quality_points(75, format).unwrap(),
                vec![60, 75, 90],
                "{format:?} 在基准 75 的取点应与现行默认质量档一致"
            );
        }
    }

    #[test]
    fn quality_points_各基准各格式_至少3点_升序去重_且在自身范围内() {
        for baseline in [0u8, 1, 37, 50, 75, 90, 99, 100] {
            for format in LOSSY_FORMATS {
                let points = quality_points(baseline, format).unwrap();
                assert!(points.len() >= 3, "基准 {baseline} 的 {format:?} 应至少 3 点：{points:?}");
                let mut sorted = points.clone();
                sorted.sort_unstable();
                assert_eq!(points, sorted, "取点应升序：{points:?}");
                let (lo, hi) = quality_range(format);
                assert!(points.iter().all(|q| (lo..=hi).contains(q)), "{format:?} 取点应落在 {lo}–{hi}：{points:?}");
            }
        }
    }

    #[test]
    fn quality_points_基准贴边_向范围内取点_不出界() {
        // JXL 有损上限 95（cjxl q100 是数学无损，与无损对照组重叠，不得出现在有损阶梯）
        assert_eq!(quality_points(100, OnestopFormat::Jxl).unwrap(), vec![70, 85, 95]);
        assert_eq!(quality_points(90, OnestopFormat::Jxl).unwrap(), vec![75, 90, 95]);
        // 基准 0 向上映射到格式下限 1
        assert_eq!(quality_points(0, OnestopFormat::Jpeg).unwrap(), vec![1, 15, 30]);
    }

    #[test]
    fn quality_points_基准越界_中文报错() {
        let message = quality_points(101, OnestopFormat::Jpeg).unwrap_err().to_string();
        assert!(message.contains("基准质量 101 无效"), "错误应点名基准值：{message}");
        assert!(message.contains("0–100"), "错误应给出有效范围：{message}");
    }

    #[test]
    fn quality_ladder_基准75_完整阶梯_顺序与现行默认完全一致() {
        let ladder = quality_ladder(75).unwrap();
        let actual: Vec<(&str, Option<u8>)> = ladder
            .iter()
            .map(|item| (item.format.as_str(), item.quality))
            .collect();
        assert_eq!(
            actual,
            vec![
                ("jpeg", Some(60)),
                ("jpeg", Some(75)),
                ("jpeg", Some(90)),
                ("webp", Some(60)),
                ("webp", Some(75)),
                ("webp", Some(90)),
                ("avif", Some(60)),
                ("avif", Some(75)),
                ("avif", Some(90)),
                ("jxl", Some(60)),
                ("jxl", Some(75)),
                ("jxl", Some(90)),
                ("png", None),
                ("webp-lossless", None),
                ("jxl-lossless", None),
            ],
            "完整阶梯 = 有损 4 格式 × 3 点 + 无损对照组，顺序与现行默认一致"
        );
        // 进度显示名与现行口径逐字一致
        assert_eq!(ladder[0].label, "JPEG q60");
        assert_eq!(ladder[11].label, "JPEG XL q90");
        assert_eq!(ladder[13].label, "无损 WebP");
    }

    #[test]
    fn ladder_item_new_有损无损的显示名各有单一来源() {
        let lossy = LadderItem::new(OnestopFormat::Avif, Some(45));
        assert_eq!(lossy.format, "avif");
        assert_eq!(lossy.label, "AVIF q45");
        let lossless = LadderItem::new(OnestopFormat::WebpLossless, None);
        assert_eq!(lossless.format, "webp-lossless");
        assert_eq!(lossless.label, "无损 WebP");
    }

    #[test]
    fn single_point_ladder_每有损格式压基准_1_点_无损组照常() {
        // v0.1.5 反馈：单点模式 = 有损 4 格式 × 基准 1 点 + 无损对照组
        let ladder = single_point_ladder(75).unwrap();
        let actual: Vec<(&str, Option<u8>)> = ladder
            .iter()
            .map(|item| (item.format.as_str(), item.quality))
            .collect();
        assert_eq!(
            actual,
            vec![
                ("jpeg", Some(75)),
                ("webp", Some(75)),
                ("avif", Some(75)),
                ("jxl", Some(75)),
                ("png", None),
                ("webp-lossless", None),
                ("jxl-lossless", None),
            ],
            "单点阶梯 = 每有损格式基准质量 1 点 + 无损组，顺序与完整阶梯一致"
        );
        assert_eq!(ladder[0].label, "JPEG q75");
    }

    #[test]
    fn single_point_ladder_基准夹到格式范围_jxl_上限_95() {
        // JXL 的有损质量上限 95（100 是数学无损，与无损组重叠）：基准 100 → 95
        let ladder = single_point_ladder(100).unwrap();
        let jxl = ladder.iter().find(|item| item.format == "jxl").unwrap();
        assert_eq!(jxl.quality, Some(95));
        let jpeg = ladder.iter().find(|item| item.format == "jpeg").unwrap();
        assert_eq!(jpeg.quality, Some(100));
    }

    #[test]
    fn single_point_ladder_越界基准报中文错误() {
        let err = single_point_ladder(101).unwrap_err();
        let message = err.to_string();
        assert!(message.contains('1'), "报错应含基准值与范围：{message}");
        assert!(message.contains("基准质量"), "报错应指明基准质量：{message}");
    }
}

// ---------- 大小优先（size_search）测试：合成单调探测函数，脱离真实编码器 ----------

#[cfg(test)]
mod size_tests {
    use super::*;

    /// 合成「质量 → 实际大小」模型：size(q) = 1000 + (q-1)×100（随质量单调不减，
    /// q1=1000 字节、q100=10900 字节）。记录调用过的质量点供断言。
    struct LinearProbe {
        calls: Vec<u8>,
    }

    impl LinearProbe {
        fn new() -> Self {
            LinearProbe { calls: Vec::new() }
        }
        fn size_of(quality: u8) -> u64 {
            1000 + (u64::from(quality) - 1) * 100
        }
        fn probe(&mut self, quality: u8) -> Result<u64, CoreError> {
            self.calls.push(quality);
            Ok(Self::size_of(quality))
        }
    }

    #[test]
    fn size_search_可达_命中最接近点_邻近补点带实测大小() {
        // 目标 5000 字节恰为 q41 的产物大小，应命中 q41 且无不可达标注
        let mut probe = LinearProbe::new();
        let result =
            size_search(OnestopFormat::Jpeg, 5000, &mut |q| probe.probe(q)).unwrap();
        assert_eq!(result.format, "jpeg");
        assert_eq!(result.hit.quality, 41);
        assert_eq!(result.hit.bytes, 5000);
        assert!(result.unreachable.is_none());
        assert!(result.annotation_note().is_none());
        // US23：命中点邻近自动补点，率失真样本 ≥3；每点带探测到的实际大小
        assert_eq!(
            result.points.iter().map(|p| p.quality).collect::<Vec<_>>(),
            vec![26, 41, 56]
        );
        assert_eq!(result.points.iter().map(|p| p.bytes).collect::<Vec<_>>(), vec![3500, 5000, 6500]);
        // 命中点复用搜索时探测过的大小，不为凑数重复编码
        assert_eq!(probe.calls.iter().filter(|q| **q == 41).count(), 1);
    }

    #[test]
    fn size_search_上下两侧等距_取不超目标的低质量点() {
        // 目标 5050：q41=5000（差 50）与 q42=5100（差 50）等距，取不超目标的 q41
        let mut probe = LinearProbe::new();
        let result =
            size_search(OnestopFormat::Jpeg, 5050, &mut |q| probe.probe(q)).unwrap();
        assert_eq!(result.hit.quality, 41);
        assert_eq!(result.hit.bytes, 5000);
    }

    #[test]
    fn size_search_目标过小不可达_回退最小质量点并标注() {
        let mut probe = LinearProbe::new();
        let result =
            size_search(OnestopFormat::Jpeg, 100, &mut |q| probe.probe(q)).unwrap();
        assert_eq!(result.hit.quality, 1);
        assert_eq!(result.hit.bytes, 1000);
        assert_eq!(result.unreachable, Some(SizeUnreachable::TargetTooSmall));
        let note = result.annotation_note().expect("不可达应携带标注");
        assert!(note.contains("不可达") && note.contains("过小"), "标注应说明不可达与原因：{note}");
        assert!(note.contains("1000"), "标注应给出实际大小：{note}");
        // 不可达时仍补邻近点（US23），且不给编码器无效范围外的质量
        assert_eq!(
            result.points.iter().map(|p| p.quality).collect::<Vec<_>>(),
            vec![1, 16, 31]
        );
    }

    #[test]
    fn size_search_目标过大不可达_回退最高质量点并标注() {
        let mut probe = LinearProbe::new();
        let result =
            size_search(OnestopFormat::Jpeg, 999_999, &mut |q| probe.probe(q)).unwrap();
        assert_eq!(result.hit.quality, 100);
        assert_eq!(result.hit.bytes, 10900);
        assert_eq!(result.unreachable, Some(SizeUnreachable::TargetTooLarge));
        let note = result.annotation_note().expect("不可达应携带标注");
        assert!(note.contains("不可达") && note.contains("过大"), "标注应说明不可达与原因：{note}");
        assert_eq!(
            result.points.iter().map(|p| p.quality).collect::<Vec<_>>(),
            vec![70, 85, 100]
        );
    }

    #[test]
    fn size_search_目标恰为边界产物大小_可达不误判() {
        // 目标 == 最小产物大小：可达（不是「过小压不到」），命中 q1
        let mut probe = LinearProbe::new();
        let result = size_search(OnestopFormat::Jpeg, 1000, &mut |q| probe.probe(q)).unwrap();
        assert_eq!(result.hit.quality, 1);
        assert!(result.unreachable.is_none());
        // 目标 == 最大产物大小：可达（不是「过大放松到顶」），命中 q100
        let mut probe = LinearProbe::new();
        let result =
            size_search(OnestopFormat::Jpeg, 10900, &mut |q| probe.probe(q)).unwrap();
        assert_eq!(result.hit.quality, 100);
        assert!(result.unreachable.is_none());
    }

    #[test]
    fn size_search_探测错误原样透传() {
        let mut probe = LinearProbe::new();
        let result = size_search(OnestopFormat::Jpeg, 5000, &mut |q| {
            if q > 50 {
                Err(CoreError::Encode {
                    message: "探测编码失败".to_string(),
                })
            } else {
                probe.probe(q)
            }
        });
        let message = result.err().expect("探测失败应报错").to_string();
        assert!(message.contains("探测编码失败"), "错误应透传：{message}");
    }

    #[test]
    fn size_search_搜索范围不越过格式自身质量范围() {
        // JXL 有损上限 95：探测不应收到 96–100
        let mut probe = LinearProbe::new();
        let result =
            size_search(OnestopFormat::Jxl, 999_999, &mut |q| probe.probe(q)).unwrap();
        assert!(probe.calls.iter().all(|q| (1..=95).contains(q)), "探测范围应在 1–95：{:?}", probe.calls);
        assert_eq!(result.hit.quality, 95);
    }
}
