//! 高级创建（T29-3）：自定义编码器参数的合并、冲突判定、命令行拼装与编码执行。
//!
//! 决策 D10/D11（notes/T29-encoder-config.md）：快速参数（质量滑块 / 目标大小 /
//! 无损开关）生成基础命令行，高级参数行统一追加到末尾；冲突判定**仅看同标志**——
//! 同一个标志（如 `-q`）在快速参数与高级参数里重复出现、或高级行之间重复，报中文
//! 错误点名标志；不同写法的同义参数（如 `-q` vs `-quality`）不判冲突，靠命令行
//! 预览让用户自查。
//!
//! 图片侧四个编码器（JPEG/WebP/AVIF/JPEG XL）带完整规格（质量范围/无损能力/输入
//! 口味/推荐参数），编码执行复用 encode.rs 的编码器解析与中间文件机制；视频侧按
//! 决策 D12–D14 提供四条静态映射规格（H.264/H.265/VP9/AV1）+ `ffmpeg -encoders`
//! 动态枚举解析（表外编码器可选但无推荐值）。

use crate::error::CoreError;
use std::collections::HashSet;
use std::path::Path;

/// 高级参数行（票面：参数名 / 标志 / 值 / 说明）。value 为 None 或空白 = 布尔开关
///（只追加标志本身）；note 为悬浮提示（精简说明 + 推荐值/范围）。enabled = false
/// 的行整体跳过（布尔开关行未勾选时由前端置 false，既不追加也不判冲突）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AdvancedParamRow {
    pub name: String,
    pub flag: String,
    pub value: Option<String>,
    pub note: Option<String>,
    pub enabled: bool,
}

impl AdvancedParamRow {
    pub fn new(name: &str, flag: &str, value: Option<&str>) -> Self {
        AdvancedParamRow {
            name: name.to_string(),
            flag: flag.to_string(),
            value: value.map(str::to_string),
            note: None,
            enabled: true,
        }
    }
}

impl Default for AdvancedParamRow {
    fn default() -> Self {
        AdvancedParamRow {
            name: String::new(),
            flag: String::new(),
            value: None,
            note: None,
            enabled: true,
        }
    }
}

/// 判断一个命令行词是不是「标志」：以 `-` 开头、后面还有字符且首字符不是数字
///（容忍 `-1` 这类负数取值不被当成标志）。
pub fn is_flag(word: &str) -> bool {
    match word.strip_prefix('-') {
        Some(rest) => !rest.is_empty() && !rest.starts_with(|c: char| c.is_ascii_digit()),
        None => false,
    }
}

/// 快速参数的基础命令行 + 高级参数行合并（决策 D10/D11）：
/// 高级参数按行序追加到基础参数末尾；任一标志重复（基础 ↔ 高级、高级行之间）报
/// 中文错误点名标志。布尔行（value 空白）只追加标志，取值行追加「标志 + 值」。
pub fn merge_args(base: &[String], rows: &[AdvancedParamRow]) -> Result<Vec<String>, CoreError> {
    let mut args: Vec<String> = base.to_vec();
    // 冲突只看同标志（D11）：基础参数里的标志 + 已合并的高级行标志都进这个集合
    let mut seen: HashSet<&str> = base
        .iter()
        .map(String::as_str)
        .filter(|word| is_flag(word))
        .collect();
    for row in rows {
        if !row.enabled {
            continue;
        }
        let name = row.name.trim();
        if name.is_empty() {
            return Err(CoreError::Encode {
                message: "高级参数行缺少参数名，请填写后重试".to_string(),
            });
        }
        let flag = row.flag.trim();
        if !is_flag(flag) {
            return Err(CoreError::Encode {
                message: format!(
                    "高级参数「{name}」的标志「{flag}」无效：标志必须以 - 开头（如 -threads 或 --sharpyuv）"
                ),
            });
        }
        if !seen.insert(flag) {
            return Err(CoreError::Encode {
                message: format!(
                    "参数标志冲突：{flag} 重复出现。同一个标志只能在快速参数或高级参数里出现一处\
                    （不同写法的同义参数不判冲突，请在命令行预览里自查）"
                ),
            });
        }
        args.push(flag.to_string());
        if let Some(value) = row.value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            args.push(value.to_string());
        }
    }
    Ok(args)
}

/// 命令行预览：可执行文件 + 参数 + 输入与输出路径，逐词过 POSIX shell 引用
///（naming::shell_quote），复制出来可直接粘贴执行。
pub fn command_line(executable: &str, args: &[String], input: &str, output: &str) -> String {
    let mut words: Vec<String> = args.to_vec();
    words.push(input.to_string());
    words.push(output.to_string());
    quote_command(executable, &words)
}

// ---------- 编码器规格（静态映射表） ----------

/// 高级参数的取值控件类型（前端按它渲染输入控件：布尔开关 / 数值 / 下拉 / 自由文本）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ParamValueKind {
    /// 布尔开关：勾选 = 生效（只追加标志），不勾选 = 行整体跳过。
    Bool,
    /// 数值输入（带范围与步长）。
    Number { min: i32, max: i32, step: i32, default: i32 },
    /// 下拉选择。
    Choice { options: Vec<String>, default: String },
    /// 自由文本。
    Text,
}

/// 编码器特有的一条推荐参数：添加参数行时从下拉里挑，行上自带说明（悬浮显示
///「精简说明 + 推荐值/范围」）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownParam {
    pub name: &'static str,
    pub flag: &'static str,
    pub kind: ParamValueKind,
    pub note: &'static str,
}

/// 高级创建的图片编码器规格：快速参数（质量滑块 / 无损开关）→ 基础命令行的
/// 单一来源（决策 D10）。格式 id 与 OnestopFormat 的有损项同名，编码执行与
/// 设置中心覆盖都复用既有分派。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageEncoderSpec {
    /// 格式标识：jpeg / webp / avif / jxl。
    pub id: &'static str,
    pub display_name: &'static str,
    /// 设置中心的编码器键：cjpeg / cwebp / avifenc / cjxl。
    pub tool_key: &'static str,
    pub quality_flag: &'static str,
    pub quality_default: u8,
    pub quality_min: u8,
    pub quality_max: u8,
    pub quality_step: u8,
    pub lossless_supported: bool,
    /// 不支持无损时的说明（无损开关禁用时的悬浮提示）。
    pub lossless_note: &'static str,
    /// 无损模式追加的参数（jxl 的无损 = q100，同样走参数表达）。
    pub lossless_args: Vec<String>,
    /// 输入口味：true = 只吃 PNG（avifenc），false = 吃 P6 PPM（cjpeg/cwebp/cjxl）。
    pub input_png: bool,
    pub output_ext: &'static str,
    /// 快速参数之外的固定附加参数（如 cwebp -quiet）。
    pub base_args: Vec<String>,
    pub known_params: Vec<KnownParam>,
}

/// 按格式 id 取图片编码器规格；未知 id 报中文错误。
pub fn image_spec(id: &str) -> Result<ImageEncoderSpec, CoreError> {
    image_specs()
        .into_iter()
        .find(|spec| spec.id == id)
        .ok_or_else(|| CoreError::Encode {
            message: format!(
                "未知的高级创建编码器：{id}（支持 jpeg / webp / avif / jxl）"
            ),
        })
}

/// 全部图片编码器规格（顺序 = 展示顺序）。
pub fn image_specs() -> Vec<ImageEncoderSpec> {
    fn param(name: &'static str, flag: &'static str, kind: ParamValueKind, note: &'static str) -> KnownParam {
        KnownParam { name, flag, kind, note }
    }
    fn text_options(options: &[&str], default: &str) -> ParamValueKind {
        ParamValueKind::Choice {
            options: options.iter().map(|s| s.to_string()).collect(),
            default: default.to_string(),
        }
    }
    vec![
        ImageEncoderSpec {
            id: "jpeg",
            display_name: "JPEG（MozJPEG）",
            tool_key: "cjpeg",
            quality_flag: "-quality",
            quality_default: 75,
            quality_min: 1,
            quality_max: 100,
            quality_step: 1,
            lossless_supported: false,
            lossless_note: "JPEG 编码器（MozJPEG）不支持无损，无损开关不可用",
            lossless_args: vec![],
            input_png: false,
            output_ext: "jpg",
            base_args: vec![],
            known_params: vec![
                param("渐进式", "-progressive", ParamValueKind::Bool, "渐进式 JPEG，网络加载逐行清晰，体积略小"),
                param("优化 Huffman", "-optimize", ParamValueKind::Bool, "优化 Huffman 表，体积略小、编码稍慢"),
                param("平滑", "-smooth", ParamValueKind::Number { min: 0, max: 100, step: 1, default: 0 }, "平滑预处理 0–100（默认 0），压制噪点图可减体积"),
            ],
        },
        ImageEncoderSpec {
            id: "webp",
            display_name: "WebP（libwebp）",
            tool_key: "cwebp",
            quality_flag: "-q",
            quality_default: 75,
            quality_min: 1,
            quality_max: 100,
            quality_step: 1,
            lossless_supported: true,
            lossless_note: "无损开关打开后质量参数不参与（cwebp -lossless）",
            lossless_args: vec!["-lossless".to_string()],
            input_png: false,
            output_ext: "webp",
            base_args: vec!["-quiet".to_string()],
            known_params: vec![
                param("预设", "-preset", text_options(&["default", "picture", "photo", "drawing", "icon", "text"], "picture"), "按内容类型的调参组合（照片选 photo，图标选 icon）"),
                param("压缩努力", "-m", ParamValueKind::Number { min: 0, max: 6, step: 1, default: 4 }, "压缩努力程度 0–6（默认 4），越大越慢、体积越小"),
                param("锐化色度", "-sharp-yuv", ParamValueKind::Bool, "锐化 YUV 采样，文字与锐边更清晰（推荐开启）"),
                param("噪声整形", "-sns", ParamValueKind::Number { min: 0, max: 100, step: 1, default: 50 }, "空间噪声整形 0–100（默认 50），过高会糊掉细节"),
            ],
        },
        ImageEncoderSpec {
            id: "avif",
            display_name: "AVIF（libavif）",
            tool_key: "avifenc",
            quality_flag: "-q",
            quality_default: 75,
            quality_min: 1,
            quality_max: 100,
            quality_step: 1,
            lossless_supported: true,
            lossless_note: "无损开关打开后质量参数不参与（avifenc --lossless）",
            lossless_args: vec!["--lossless".to_string()],
            input_png: true,
            output_ext: "avif",
            base_args: vec![],
            known_params: vec![
                param("编码速度", "-s", ParamValueKind::Number { min: 0, max: 10, step: 1, default: 6 }, "编码速度 0–10（默认 6），越小越慢、同体积质量越好"),
                param("并行线程", "-j", ParamValueKind::Number { min: 1, max: 64, step: 1, default: 1 }, "并行线程数（默认 1），多核机器可加速"),
                param("色度采样", "-y", text_options(&["420", "422", "444"], "420"), "色度子采样：420 常规（默认），444 保留全彩色"),
                param("锐化色度", "--sharpyuv", ParamValueKind::Bool, "锐化 YUV 采样，彩色边缘更干净"),
            ],
        },
        ImageEncoderSpec {
            id: "jxl",
            display_name: "JPEG XL（libjxl）",
            tool_key: "cjxl",
            quality_flag: "-q",
            quality_default: 75,
            quality_min: 1,
            quality_max: 95,
            quality_step: 1,
            lossless_supported: true,
            lossless_note: "无损 = 质量 100（cjxl 的数学无损），打开后质量参数锁定 100",
            lossless_args: vec!["-q".to_string(), "100".to_string()],
            input_png: false,
            output_ext: "jxl",
            base_args: vec!["--quiet".to_string()],
            known_params: vec![
                param("编码努力", "-e", ParamValueKind::Number { min: 1, max: 10, step: 1, default: 7 }, "编码努力程度 1–10（默认 7），越大越慢、体积越小"),
                param("Modular 模式", "--modular", ParamValueKind::Bool, "Modular 编码，非照片内容（图标/插画）更小"),
                param("并行线程", "--num_threads", ParamValueKind::Number { min: 1, max: 64, step: 1, default: 1 }, "并行线程数（默认 1），多核机器可加速"),
            ],
        },
    ]
}

/// 快速参数 → 基础命令行参数（决策 D10 的核心映射）：
/// - lossless = true：追加规格的 lossless_args（不支持时中文报错）；
/// - 否则按质量模式：追加 quality_flag + 质量值（越界中文报错）。
/// 大小优先模式在执行时先搜索出实际质量点，再走质量模式（D8：命名写实际质量点）。
pub fn quick_base_args(
    spec: &ImageEncoderSpec,
    lossless: bool,
    quality: u8,
) -> Result<Vec<String>, CoreError> {
    let mut args: Vec<String> = spec.base_args.clone();
    if lossless {
        if !spec.lossless_supported {
            return Err(CoreError::Encode {
                message: format!("{}：{}", spec.display_name, spec.lossless_note),
            });
        }
        args.extend(spec.lossless_args.iter().cloned());
        return Ok(args);
    }
    if quality < spec.quality_min || quality > spec.quality_max {
        return Err(CoreError::Encode {
            message: format!(
                "{} 的质量 {quality} 无效，有效范围 {}–{}",
                spec.display_name, spec.quality_min, spec.quality_max
            ),
        });
    }
    args.push(spec.quality_flag.to_string());
    args.push(quality.to_string());
    Ok(args)
}

/// 视频编码器规格（决策 D12–D14 静态映射表）：按容器格式拆四条，带 ffmpeg 编码器名、
/// 质量参数（-crf 系）与无损能力。`ffmpeg -encoders` 枚举到的表外编码器也可选，
/// 但没有规格（无推荐值）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoEncoderSpec {
    /// 规格标识：h264 / h265 / vp9 / av1。
    pub id: &'static str,
    pub display_name: &'static str,
    /// 静态映射的 ffmpeg 编码器名（-c:v 的取值）。
    pub ffmpeg_name: &'static str,
    pub quality_flag: &'static str,
    pub quality_default: u8,
    pub quality_min: u8,
    pub quality_max: u8,
    pub lossless_supported: bool,
    pub lossless_args: Vec<String>,
    pub lossless_note: &'static str,
    /// 命令行固定附加参数（如 VP9 需 -b:v 0 才能让 -crf 生效）。
    pub base_args: Vec<String>,
    pub known_params: Vec<KnownParam>,
    pub note: &'static str,
}

/// 全部视频编码器规格（顺序 = 展示顺序）。
pub fn video_specs() -> Vec<VideoEncoderSpec> {
    fn param(name: &'static str, flag: &'static str, kind: ParamValueKind, note: &'static str) -> KnownParam {
        KnownParam { name, flag, kind, note }
    }
    fn choices(options: &[&str], default: &str) -> ParamValueKind {
        ParamValueKind::Choice {
            options: options.iter().map(|s| s.to_string()).collect(),
            default: default.to_string(),
        }
    }
    fn number(min: i32, max: i32, step: i32, default: i32) -> ParamValueKind {
        ParamValueKind::Number { min, max, step, default }
    }
    let preset_choices = ["ultrafast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"];
    vec![
        VideoEncoderSpec {
            id: "h264",
            display_name: "H.264（libx264）",
            ffmpeg_name: "libx264",
            quality_flag: "-crf",
            quality_default: 23,
            quality_min: 0,
            quality_max: 51,
            lossless_supported: true,
            lossless_args: vec!["-crf".to_string(), "0".to_string()],
            lossless_note: "无损 = -crf 0，打开后质量参数锁定 0",
            base_args: vec![],
            known_params: vec![
                param("速度档", "-preset", choices(&preset_choices, "medium"), "编码速度档（默认 medium），越慢压缩效率越高"),
                param("内容微调", "-tune", choices(&["film", "animation", "stillimage", "fastdecode", "zerolatency"], "film"), "按内容类型微调（真人影视 film、动画 animation）"),
            ],
            note: "兼容性最好的通用编码器，H.264 是基准对比的常用锚点",
        },
        VideoEncoderSpec {
            id: "h265",
            display_name: "H.265（libx265）",
            ffmpeg_name: "libx265",
            quality_flag: "-crf",
            quality_default: 28,
            quality_min: 0,
            quality_max: 51,
            lossless_supported: true,
            lossless_args: vec!["-crf".to_string(), "0".to_string()],
            lossless_note: "无损 = -crf 0，打开后质量参数锁定 0",
            base_args: vec![],
            known_params: vec![
                param("速度档", "-preset", choices(&preset_choices, "medium"), "编码速度档（默认 medium），越慢压缩效率越高"),
                param("指标微调", "-tune", choices(&["psnr", "ssim", "zerolatency"], "psnr"), "按目标指标微调（与跑分指标对齐可选 psnr/ssim）"),
            ],
            note: "同画质比 H.264 更省码率，编码与播放都更吃性能",
        },
        VideoEncoderSpec {
            id: "vp9",
            display_name: "VP9（libvpx-vp9）",
            ffmpeg_name: "libvpx-vp9",
            quality_flag: "-crf",
            quality_default: 31,
            quality_min: 0,
            quality_max: 63,
            lossless_supported: true,
            lossless_args: vec!["-lossless".to_string(), "1".to_string()],
            lossless_note: "无损 = -lossless 1，打开后质量参数不参与",
            base_args: vec!["-b:v".to_string(), "0".to_string()],
            known_params: vec![
                param("行级多线程", "-row-mt", ParamValueKind::Bool, "行级多线程并行，编码明显加速（推荐开启）"),
                param("调度模式", "-deadline", choices(&["good", "best", "realtime"], "good"), "good 兼顾速度与质量（默认）、best 最慢最好"),
                param("速度档", "-cpu-used", number(0, 5, 1, 1), "速度档 0–5（默认 1），越大越快、质量略降"),
            ],
            note: "WebM 生态主力编码器，与 libvpx 系播放器兼容性好",
        },
        VideoEncoderSpec {
            id: "av1",
            display_name: "AV1（libsvtav1）",
            ffmpeg_name: "libsvtav1",
            quality_flag: "-crf",
            quality_default: 30,
            quality_min: 0,
            quality_max: 63,
            lossless_supported: false,
            lossless_args: vec![],
            lossless_note: "SVT-AV1 不支持真无损（-crf 0 只是最接近点），无损开关不可用",
            base_args: vec![],
            known_params: vec![
                param("速度档", "-preset", number(0, 13, 1, 8), "速度档 0–13（默认 8），越大越快、压缩率略降"),
                param("关键帧间隔", "-g", number(12, 600, 12, 240), "GOP 长度/关键帧间隔（默认 240）"),
            ],
            note: "新一代开源编码器，压缩率最高但编码最慢",
        },
    ]
}

/// 解析 `ffmpeg -encoders` 输出里的视频编码器名称（纯函数，注入输出便于单测）。
/// 行首标志列形如 ` V....D `：只认「全大写字母/点的短字段且含 V」的行，取第二列
/// 名称；说明行、音频/字幕编码器一律跳过。
pub fn parse_ffmpeg_encoders(output: &str) -> Vec<String> {
    let mut names = Vec::new();
    for line in output.lines() {
        let mut tokens = line.trim().split_whitespace();
        let Some(flags) = tokens.next() else {
            continue;
        };
        let looks_like_flags = flags.len() <= 8
            && flags.chars().all(|c| matches!(c, 'V' | 'A' | 'S' | 'D' | 'N' | 'B' | 'T' | '.'))
            && flags.contains('V');
        if !looks_like_flags {
            continue;
        }
        if let Some(name) = tokens.next() {
            names.push(name.to_string());
        }
    }
    names
}

// ---------- 高级图片编码执行 ----------

/// 高级创建的快速模式（决策 D10）：质量 = 滑块定值；大小 = 目标字节数（执行时先
/// 搜索实际质量点，D8：命名与编码参数文本都写实际质量点）。
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AdvancedQuickMode {
    Quality,
    Size,
}

/// 高级创建的单个编码任务：格式 + 快速参数（无损开关 / 模式 / 质量 / 目标大小）
/// + 高级参数行（已按界面勾选状态过滤 enabled）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedImageJob {
    pub format_id: String,
    pub lossless: bool,
    pub mode: AdvancedQuickMode,
    pub quality: u8,
    pub target_bytes: u64,
    #[serde(default)]
    pub rows: Vec<AdvancedParamRow>,
}

/// 高级创建的产物：路径 + 编码参数文本（随评测轮持久化）+ 实际执行命令行 +
/// 不可达标注（大小优先搜索回退时）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedProduct {
    pub path: String,
    pub encoding_params: String,
    pub command_line: String,
    pub note: Option<String>,
}

/// 生效高级参数行的「标志 [值]」词序列（布尔行只有标志，未启用的行整体跳过）：
/// 编码参数文本（[`advanced_params_text`]）与产物文件名的括号参数段共用同一来源，
/// 避免两处口径分叉。
fn enabled_row_words(rows: &[AdvancedParamRow]) -> Vec<String> {
    let mut words: Vec<String> = Vec::new();
    for row in rows {
        if !row.enabled {
            continue;
        }
        words.push(row.flag.trim().to_string());
        if let Some(value) = row.value.as_deref().map(str::trim).filter(|v| !v.is_empty()) {
            words.push(value.to_string());
        }
    }
    words
}

/// 编码参数文本（结果表「编码参数」列）：`AVIF（libavif） q60（-s 4 --sharpyuv）`
/// 式——质量段与一站式同口径，括号里是生效的高级参数词（不 shell 引用，给人看）。
pub fn advanced_params_text(
    display_name: &str,
    lossless: bool,
    quality: u8,
    rows: &[AdvancedParamRow],
) -> String {
    let mut text = if lossless {
        format!("{display_name} 无损")
    } else {
        format!("{display_name} q{quality}")
    };
    let words = enabled_row_words(rows);
    if !words.is_empty() {
        text.push_str(&format!("（{}）", words.join(" ")));
    }
    text
}

/// 高级创建任务的实际质量点解析（encode_advanced_image 与 advanced_product_name
/// 共用，两处口径一字不差）：无损直接定档；大小优先先搜索实际质量点（探测编码到
/// 暂存目录即弃）；质量优先用任务自带档位。返回（无损, 实际质量, 不可达标注）。
fn resolve_advanced_quality(
    source: &Path,
    job: &AdvancedImageJob,
    tools_dir: &Path,
    overrides: &crate::encode::EncoderOverrides,
) -> Result<(bool, u8, Option<String>), CoreError> {
    use crate::encode::{probe_onestop_size, OnestopFormat};
    use crate::ladder::size_search;

    let format = OnestopFormat::parse(&job.format_id)?;
    let spec = image_spec(&job.format_id)?;
    if job.lossless {
        return Ok((true, spec.quality_default, None));
    }
    if job.mode == AdvancedQuickMode::Size {
        let scratch = tempfile::tempdir().map_err(|err| CoreError::Encode {
            message: format!("无法创建探测暂存目录：{err}"),
        })?;
        let result = size_search(format, job.target_bytes, &mut |quality| {
            probe_onestop_size(source, format, quality, scratch.path(), tools_dir, overrides)
        })?;
        Ok((false, result.hit.quality, result.annotation_note()))
    } else {
        Ok((false, job.quality, None))
    }
}

/// 高级创建的产物文件名（encode_advanced_image 与 advanced_product_name 共用）：
/// 质量段写实际质量点，高级参数词进括号参数段（需求 9；词序列与编码参数文本同一
/// 来源 enabled_row_words）。
fn advanced_file_name(
    source: &Path,
    job: &AdvancedImageJob,
    format: crate::encode::OnestopFormat,
    spec: &ImageEncoderSpec,
    lossless: bool,
    quality: u8,
) -> Result<String, CoreError> {
    use crate::encode::file_stem;
    use crate::naming::{product_file_name, QualitySegment};

    let stem = file_stem(source)?;
    let custom_words = enabled_row_words(&job.rows);
    let custom_words: Vec<&str> = custom_words.iter().map(String::as_str).collect();
    let segment = if lossless {
        QualitySegment::Lossless
    } else {
        QualitySegment::Lossy(quality)
    };
    product_file_name(&stem, format.encoder_short_name(), segment, &custom_words, spec.output_ext)
}

/// 高级创建产物的目标文件名（T30 询问策略用）：与正式编码同一套质量解析与命名
/// 来源（encode_advanced_image 内部同样走 resolve_advanced_quality +
/// advanced_file_name），GUI 在写入前据此探测同名冲突。大小优先模式会先跑逼近
/// 搜索（探测编码在暂存目录完成、即弃），这是写入前拿到确切名的必要成本。
pub fn advanced_product_name(
    source: impl AsRef<Path>,
    job: &AdvancedImageJob,
    tools_dir: impl AsRef<Path>,
    overrides: &crate::encode::EncoderOverrides,
) -> Result<String, CoreError> {
    use crate::encode::OnestopFormat;

    let format = OnestopFormat::parse(&job.format_id)?;
    let spec = image_spec(&job.format_id)?;
    let (lossless, quality, _note) =
        resolve_advanced_quality(source.as_ref(), job, tools_dir.as_ref(), overrides)?;
    advanced_file_name(source.as_ref(), job, format, &spec, lossless, quality)
}

/// 高级创建：按任务把原图编码为一份跑分产物。
///
/// - 编码器解析与一站式共用同一分派（设置中心覆盖优先，缺省内置自动安装）；
/// - 快速参数生成基础命令行，高级参数行追加到末尾（D10），同标志冲突报中文错误；
/// - 大小优先模式先用目标大小搜索实际质量点（探测编码走一站式探测缝，不含高级
///   参数——高级参数会影响实际大小，最终以预览与产物自查为准）；
/// - 产物按 T29-1 命名新格式落盘，质量段写实际质量点（D8）、高级参数进括号参数段
///  （需求 9 示例 `image123_avif_q60_(-y 420 --sharpyuv -s 4).avif`）；
/// - 同名冲突按 `conflict` 处理（D9 + T30）：AutoAppend 自动追加 `_1/_2` 不覆盖，
///   Overwrite 用确切名落位覆盖（编码先进产物目录下的暂存子目录完成——暂存内必然
///   无冲突，成功后一次 rename 覆盖已有文件；中途失败暂存目录整体丢弃）；
/// - AVIF/JXL 产物写完自检解码并旁路 PNG 代片（决策 0012，与一站式一致）。
pub fn encode_advanced_image(
    source: impl AsRef<Path>,
    job: &AdvancedImageJob,
    output_dir: impl AsRef<Path>,
    tools_dir: impl AsRef<Path>,
    overrides: &crate::encode::EncoderOverrides,
    conflict: crate::naming::ConflictPolicy,
) -> Result<AdvancedProduct, CoreError> {
    use crate::encode::{
        resolve_onestop_encoder, run_subprocess, write_png_temp, write_ppm_temp, OnestopFormat,
    };
    use crate::naming::{resolve_product_name, ConflictPolicy};

    let spec = image_spec(&job.format_id)?;
    let format = OnestopFormat::parse(&job.format_id)?;
    let source = source.as_ref();
    let output_dir = output_dir.as_ref();
    let tools_dir = tools_dir.as_ref();

    // 参数先行 fail-fast（决策 D10/D11 + 票面「明确报错」）：无损能力、质量范围与
    // 同标志冲突都在编码器解析之前校验——坏参数不联网、不安装、不编码。
    // 大小优先的质量值由搜索决定，占位用默认值：标志集合与最终一致，冲突判定等价。
    let placeholder_quality = match (job.lossless, &job.mode) {
        (true, _) => spec.quality_default,
        (false, AdvancedQuickMode::Size) => spec.quality_default,
        (false, AdvancedQuickMode::Quality) => job.quality,
    };
    let placeholder_base = quick_base_args(&spec, job.lossless, placeholder_quality)?;
    merge_args(&placeholder_base, &job.rows)?;

    let encoder = resolve_onestop_encoder(format, tools_dir, overrides)?
        .expect("高级创建只支持有损四格式，无进程内 PNG 分支");

    let (lossless, quality, note) = resolve_advanced_quality(source, job, tools_dir, overrides)?;

    let base = quick_base_args(&spec, lossless, quality)?;
    let merged = merge_args(&base, &job.rows)?;

    // 解码口径与跑分一致：喂给编码器的像素 = 算指标时看到的像素
    let decoded = crate::metrics::decode_srgb(source)?;
    std::fs::create_dir_all(output_dir).map_err(|err| CoreError::Encode {
        message: format!("无法创建产物目录 {}：{err}", output_dir.display()),
    })?;

    // T30 覆盖模式：编码在暂存子目录里做（名字解析在空目录里原样返回确切名），
    // 成功后 rename 进产物目录覆盖已有同名文件。tempdir_in 保证暂存与最终落位
    // 同一文件系统（rename 原子生效）。
    let scratch = match conflict {
        ConflictPolicy::AutoAppend => None,
        ConflictPolicy::Overwrite => Some(
            tempfile::tempdir_in(output_dir).map_err(|err| CoreError::Encode {
                message: format!("无法创建编码暂存目录（覆盖模式）：{err}"),
            })?,
        ),
    };
    let encode_dir: &Path = scratch.as_ref().map(|dir| dir.path()).unwrap_or(output_dir);

    let name = resolve_product_name(
        encode_dir,
        &advanced_file_name(source, job, format, &spec, lossless, quality)?,
        conflict,
    )?;
    let product = encode_dir.join(&name);
    let product_tmp = encode_dir.join(format!("{name}.tmp"));

    // 参数在前、输入与输出按编码器口味落位（layout_words 单一来源，命令行预览同用）：
    // cjpeg 用 -outfile（输入收尾），cwebp 输入后跟 -o，avifenc/cjxl 输入 + 输出位置参数
    let input = if spec.input_png {
        write_png_temp(&decoded)?
    } else {
        write_ppm_temp(&decoded)?
    };
    let mut command = std::process::Command::new(&encoder);
    for word in &layout_words(spec.id, &merged, input.path().to_string_lossy().as_ref(), &product_tmp) {
        command.arg(word);
    }

    let label = format!("{}（{}）", spec.display_name, spec.tool_key);
    let result = run_subprocess(&encoder, command, &label, &product_tmp);
    let mut product = match crate::encode::finish_product(result, &product_tmp, &product) {
        Ok(path) => path,
        Err(err) => {
            std::fs::remove_file(&product_tmp).ok();
            return Err(err);
        }
    };

    // 覆盖模式落位：暂存产物 rename 到确切目标名（三端 rename 均替换已有文件；
    // 大小写仅差异的名字在 Linux 上会并存，见 ADR 0023 口径说明）。
    // scratch 变量本身保留到函数收尾才 drop：暂存目录必须活过落位 rename。
    if scratch.is_some() {
        let dest = output_dir.join(product.file_name().expect("暂存产物必有文件名"));
        std::fs::rename(&product, &dest).map_err(|err| CoreError::Encode {
            message: format!("无法覆盖保存产物 {}：{err}", dest.display()),
        })?;
        product = dest;
    }

    // AVIF/JXL 产物 WebView 原生解不了：自检解码 + 旁路 PNG 代片（决策 0012）
    if matches!(format, OnestopFormat::Avif | OnestopFormat::Jxl) {
        if let Err(err) = crate::encode::write_view_proxy(&product) {
            std::fs::remove_file(&product).ok();
            return Err(err);
        }
    }

    // 命令行预览按「用户可复制」口径记录：输入显示原图路径（工具内部会先按口味
    // 转中间文件），输出为最终产物路径，含布局词（-outfile 等）。
    Ok(AdvancedProduct {
        path: product.to_string_lossy().into_owned(),
        encoding_params: advanced_params_text(spec.display_name, lossless, quality, &job.rows),
        command_line: quote_command(
            &encoder.display().to_string(),
            &layout_words(spec.id, &merged, &source.display().to_string(), &product),
        ),
        note,
    })
}

/// 逐词 shell 引用拼命令行（可执行文件 + 词序列）。
pub fn quote_command(executable: &str, words: &[String]) -> String {
    std::iter::once(executable)
        .chain(words.iter().map(String::as_str))
        .map(crate::naming::shell_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

/// 编码器的命令行布局（可执行文件之后的全部词）：`参数…` + 输入/输出按编码器口味
/// 落位。真实执行与命令行预览共用同一来源，避免「预览的命令」和「实际跑的命令」分叉。
pub fn layout_words(spec_id: &str, args: &[String], input: &str, output: &Path) -> Vec<String> {
    let mut words: Vec<String> = args.to_vec();
    match spec_id {
        "jpeg" => {
            words.push("-outfile".to_string());
            words.push(output.display().to_string());
            words.push(input.to_string());
        }
        "webp" => {
            words.push(input.to_string());
            words.push("-o".to_string());
            words.push(output.display().to_string());
        }
        _ => {
            words.push(input.to_string());
            words.push(output.display().to_string());
        }
    }
    words
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    fn row(name: &str, flag: &str, value: Option<&str>) -> AdvancedParamRow {
        AdvancedParamRow {
            name: name.to_string(),
            flag: flag.to_string(),
            value: value.map(str::to_string),
            note: None,
            enabled: true,
        }
    }

    fn base(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn merge_args_skips_disabled_rows() {
        let mut off = row("锐化", "--sharpyuv", None);
        off.enabled = false;
        let merged = merge_args(&base(&["-q", "75"]), &[off]).unwrap();
        assert_eq!(merged, base(&["-q", "75"]));
    }

    #[test]
    fn merge_args_disabled_row_with_duplicate_flag_does_not_conflict() {
        // 未启用的行不参与冲突判定：勾选与否是运行中的开关，不该报错拦人
        let mut off = row("自定义质量", "-q", Some("60"));
        off.enabled = false;
        let merged = merge_args(&base(&["-q", "75"]), &[off]).unwrap();
        assert_eq!(merged, base(&["-q", "75"]));
    }

    // ---------- merge_args（决策 D10/D11：追加 + 仅同标志判冲突） ----------

    #[test]
    fn merge_args_appends_rows_after_base() {
        let merged = merge_args(
            &base(&["-quiet", "-q", "75"]),
            &[
                row("线程数", "-j", Some("4")),
                row("渐进式", "-progressive", None),
            ],
        )
        .unwrap();
        assert_eq!(
            merged,
            base(&["-quiet", "-q", "75", "-j", "4", "-progressive"])
        );
    }

    #[test]
    fn merge_args_blank_value_means_boolean_flag() {
        let merged = merge_args(&base(&[]), &[row("锐化", "--sharpyuv", Some("  "))]).unwrap();
        assert_eq!(merged, base(&["--sharpyuv"]));
    }

    #[test]
    fn merge_args_flag_conflict_with_base_is_rejected() {
        let err = merge_args(
            &base(&["-q", "75"]),
            &[row("自定义质量", "-q", Some("60"))],
        )
        .err()
        .expect("与快速参数同标志应判冲突");
        assert!(err.to_string().contains("-q"), "错误应点名冲突标志: {err}");
    }

    #[test]
    fn merge_args_flag_conflict_between_rows_is_rejected() {
        let err = merge_args(
            &base(&[]),
            &[row("速度", "-s", Some("4")), row("再写一次速度", "-s", None)],
        )
        .err()
        .expect("高级行之间同标志应判冲突");
        assert!(err.to_string().contains("-s"), "错误应点名冲突标志: {err}");
    }

    #[test]
    fn merge_args_negative_number_value_is_not_a_flag() {
        // 值为负数（如 -1）不算标志：既不冲突，也不被当成重复标志
        let merged = merge_args(&base(&["-t", "-1"]), &[row("锐化", "-af", None)]).unwrap();
        assert_eq!(merged, base(&["-t", "-1", "-af"]));
    }

    #[test]
    fn merge_args_row_without_dash_flag_is_rejected() {
        let err = merge_args(&base(&[]), &[row("坏行", "sharpyuv", None)])
            .err()
            .expect("标志必须以 - 开头");
        assert!(err.to_string().contains("sharpyuv"), "{err}");
    }

    #[test]
    fn merge_args_row_without_name_is_rejected() {
        let err = merge_args(&base(&[]), &[row("", "-af", None)])
            .err()
            .expect("参数名必填");
        assert!(err.to_string().contains("参数名"), "{err}");
    }

    #[test]
    fn merge_args_same_word_twice_in_base_is_not_advanced_conflict() {
        // 基础参数内部的重复不在本函数职责内（由规格表保证不重复），只看高级行
        let merged = merge_args(&base(&["-q", "75"]), &[]).unwrap();
        assert_eq!(merged, base(&["-q", "75"]));
    }

    // ---------- command_line（预览可复制、可直接在 shell 执行） ----------

    #[test]
    fn command_line_quotes_words_with_spaces() {
        let line = command_line(
            "/opt/avifenc",
            &["-q".to_string(), "60".to_string()],
            "/tmp/my photo.png",
            "/out/x.avif",
        );
        assert_eq!(line, "/opt/avifenc -q 60 '/tmp/my photo.png' /out/x.avif");
    }

    // ---------- 图片编码器规格（静态映射，钉死面向用户的关键值） ----------

    #[test]
    fn image_specs_cover_four_lossy_formats_in_order() {
        let ids: Vec<&str> = image_specs().iter().map(|s| s.id).collect();
        assert_eq!(ids, ["jpeg", "webp", "avif", "jxl"]);
        for spec in image_specs() {
            assert!(
                !spec.known_params.is_empty(),
                "{} 应至少带一条推荐参数",
                spec.id
            );
            assert!(
                spec.known_params.iter().all(|p| p.note.contains('，')),
                "{} 的推荐参数说明应含精简说明+推荐值/范围",
                spec.id
            );
        }
    }

    #[test]
    fn image_spec_pins_key_capabilities() {
        let jpeg = image_spec("jpeg").unwrap();
        assert_eq!(jpeg.tool_key, "cjpeg");
        assert_eq!(jpeg.quality_flag, "-quality");
        assert_eq!((jpeg.quality_min, jpeg.quality_max, jpeg.quality_step), (1, 100, 1));
        assert_eq!(jpeg.quality_default, 75);
        assert!(!jpeg.lossless_supported, "JPEG 编码器不支持无损");
        assert_eq!(jpeg.output_ext, "jpg");
        assert!(!jpeg.input_png, "cjpeg 吃 PPM");

        let webp = image_spec("webp").unwrap();
        assert_eq!(webp.quality_flag, "-q");
        assert!(webp.lossless_supported);
        assert!(!webp.input_png);

        let avif = image_spec("avif").unwrap();
        assert_eq!(avif.tool_key, "avifenc");
        assert!(avif.lossless_supported);
        assert!(avif.input_png, "avifenc 只吃 PNG");
        assert_eq!(avif.output_ext, "avif");

        let jxl = image_spec("jxl").unwrap();
        assert_eq!(jxl.quality_max, 95, "cjxl 的 100 是数学无损，有损上限收到 95");
        assert!(jxl.lossless_supported);
    }

    #[test]
    fn image_spec_unknown_id_reports_chinese_error() {
        let err = image_spec("webm").err().expect("未知格式应报错");
        assert!(err.to_string().contains("webm"), "{err}");
    }

    // ---------- quick_base_args（决策 D10：快速参数 → 基础命令行） ----------

    #[test]
    fn quick_base_args_quality_mode_uses_encoder_specific_flag() {
        let jpeg = image_spec("jpeg").unwrap();
        assert_eq!(quick_base_args(&jpeg, false, 75).unwrap(), base(&["-quality", "75"]));
        let webp = image_spec("webp").unwrap();
        assert_eq!(quick_base_args(&webp, false, 75).unwrap(), base(&["-quiet", "-q", "75"]));
        let avif = image_spec("avif").unwrap();
        assert_eq!(quick_base_args(&avif, false, 60).unwrap(), base(&["-q", "60"]));
        let jxl = image_spec("jxl").unwrap();
        assert_eq!(quick_base_args(&jxl, false, 80).unwrap(), base(&["--quiet", "-q", "80"]));
    }

    #[test]
    fn quick_base_args_lossless_mode_per_capability() {
        let webp = image_spec("webp").unwrap();
        assert_eq!(quick_base_args(&webp, true, 75).unwrap(), base(&["-quiet", "-lossless"]));
        let avif = image_spec("avif").unwrap();
        assert_eq!(quick_base_args(&avif, true, 60).unwrap(), base(&["--lossless"]));
        let jxl = image_spec("jxl").unwrap();
        assert_eq!(quick_base_args(&jxl, true, 80).unwrap(), base(&["--quiet", "-q", "100"]));
    }

    #[test]
    fn quick_base_args_lossless_on_unsupported_encoder_is_rejected() {
        let jpeg = image_spec("jpeg").unwrap();
        let err = quick_base_args(&jpeg, true, 75).err().expect("JPEG 无损应报错");
        assert!(err.to_string().contains("无损"), "{err}");
    }

    #[test]
    fn quick_base_args_out_of_range_quality_is_rejected() {
        let jxl = image_spec("jxl").unwrap();
        let err = quick_base_args(&jxl, false, 96).err().expect("超过 jxl 有损上限应报错");
        assert!(err.to_string().contains("质量"), "{err}");
        let err0 = quick_base_args(&jxl, false, 0).err().expect("0 应报错");
        assert!(err0.to_string().contains("质量"), "{err0}");
    }

    // ---------- 视频编码器规格（决策 D12/D13：按格式拆 + 无损能力） ----------

    #[test]
    fn video_specs_pin_formats_and_defaults() {
        let specs = video_specs();
        let ids: Vec<&str> = specs.iter().map(|s| s.id).collect();
        assert_eq!(ids, ["h264", "h265", "vp9", "av1"]);
        let names: Vec<&str> = specs.iter().map(|s| s.ffmpeg_name).collect();
        assert_eq!(names, ["libx264", "libx265", "libvpx-vp9", "libsvtav1"]);
        let defaults: Vec<u8> = specs.iter().map(|s| s.quality_default).collect();
        assert_eq!(defaults, [23, 28, 31, 30]);
        let flags: Vec<&str> = specs.iter().map(|s| s.quality_flag).collect();
        assert_eq!(flags, ["-crf", "-crf", "-crf", "-crf"]);
    }

    #[test]
    fn video_specs_lossless_capability_matches_decision_d13() {
        let specs = video_specs();
        let av1 = specs.iter().find(|s| s.id == "av1").unwrap();
        assert!(!av1.lossless_supported, "SVT-AV1 无真无损，无损开关应禁用");
        let vp9 = specs.iter().find(|s| s.id == "vp9").unwrap();
        assert_eq!(vp9.lossless_args, ["-lossless", "1"]);
        let h264 = specs.iter().find(|s| s.id == "h264").unwrap();
        assert_eq!(h264.lossless_args, ["-crf", "0"]);
        // VP9 的 -crf 必须配 -b:v 0 才生效
        let vp9 = specs.iter().find(|s| s.id == "vp9").unwrap();
        assert_eq!(vp9.base_args, ["-b:v", "0"]);
    }

    // ---------- parse_ffmpeg_encoders（决策 D14：动态枚举名称） ----------

    const SAMPLE_ENCODERS_OUTPUT: &str = "\
ffmpeg version 9.0.2 Copyright (c) 2000-2025 the FFmpeg developers
built with gcc 13 (Ubuntu 13.2.0-23ubuntu4)
Hyper fast Audio and Video encoder
usage: ffmpeg [options] [[infile options] -i infile]... {[outfile options] outfile}...

Video encoders:
 A..... aac                  AAC (Advanced Audio Coding)
 V....D libx264              libx264 H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (codec h264)
 V..... libvpx-vp9           libvpx VP9 (codec vp9)
 V....D libsvtav1            SVT-AV1(Scalable Video Technology for AV1) encoder (codec av1)
 V....D libopenh264          OpenH264 H.264 encoder (codec h264)
 ------ behind some obscure encoder line
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder (codec h264)

Audio encoders:
 A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3)
";

    #[test]
    fn parse_ffmpeg_encoders_extracts_video_encoder_names() {
        let names = parse_ffmpeg_encoders(SAMPLE_ENCODERS_OUTPUT);
        assert_eq!(
            names,
            ["libx264", "libvpx-vp9", "libsvtav1", "libopenh264", "h264_nvenc"]
        );
    }

    #[test]
    fn parse_ffmpeg_encoders_skips_non_video_and_garbage_lines() {
        assert!(parse_ffmpeg_encoders("").is_empty());
        assert!(parse_ffmpeg_encoders("随便一段不是 encoders 输出的文本").is_empty());
        // 音频编码器（标志列无 V）不进清单
        let names = parse_ffmpeg_encoders(" A..... aac AAC (Advanced Audio Coding)");
        assert!(names.is_empty());
    }

    // ---------- advanced_params_text（编码参数文本，随评测轮持久化） ----------

    #[test]
    fn advanced_params_text_covers_quality_lossless_and_custom_words() {
        assert_eq!(advanced_params_text("AVIF（libavif）", false, 60, &[]), "AVIF（libavif） q60");
        assert_eq!(advanced_params_text("WebP（libwebp）", true, 75, &[]), "WebP（libwebp） 无损");
        let rows = vec![
            AdvancedParamRow::new("编码速度", "-s", Some("4")),
            AdvancedParamRow::new("锐化色度", "--sharpyuv", None),
            {
                let mut off = AdvancedParamRow::new("未启用", "-off", None);
                off.enabled = false;
                off
            },
        ];
        assert_eq!(
            advanced_params_text("AVIF（libavif）", false, 60, &rows),
            "AVIF（libavif） q60（-s 4 --sharpyuv）"
        );
    }

    // ---------- encode_advanced_image（桩编码器端到端，全程不联网） ----------

    /// 桩编码器：从参数里找 -outfile / -o 的取值（或最后一个位置参数）当输出，
    /// 写入固定内容。高级创建四种布局（-outfile 收尾 / -o / 输入输出位置参数）
    /// 与大小优先探测（encode_jpeg_using 布局）都能命中。
    fn write_stub_encoder(dir: &Path, name: &str) -> PathBuf {
        let stub = dir.join(name);
        std::fs::write(
            &stub,
            "#!/bin/sh\nout=\"\"\nprev=\"\"\nfor a in \"$@\"; do\n  case \"$prev\" in -outfile|-o) out=\"$a\";; esac\n  prev=\"$a\"\ndone\nif [ -z \"$out\" ]; then\n  for a in \"$@\"; do out=\"$a\"; done\nfi\necho FAKE > \"$out\"\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        stub
    }

    fn fixture(name: &str) -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/data").join(name)
    }

    #[cfg(unix)]
    #[test]
    fn advanced_jpeg_product_uses_merged_args_and_new_naming() {
        let dir = std::env::temp_dir().join(format!("pixel-arena-t293-jpeg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = write_stub_encoder(&dir, "my-cjpeg.sh");

        let out_dir = dir.join("out");
        let job = AdvancedImageJob {
            format_id: "jpeg".to_string(),
            lossless: false,
            mode: AdvancedQuickMode::Quality,
            quality: 75,
            target_bytes: 0,
            rows: vec![AdvancedParamRow::new("渐进式", "-progressive", None)],
        };
        let product = encode_advanced_image(
            fixture("photo-ref.png"),
            &job,
            &out_dir,
            dir.join("tools"),
            &crate::encode::EncoderOverrides {
                cjpeg: Some(stub.clone()),
                ..Default::default()
            },
            crate::naming::ConflictPolicy::AutoAppend,
        )
        .expect("高级创建应成功");
        assert!(Path::new(&product.path).exists(), "产物应落盘");
        assert_eq!(
            Path::new(&product.path).file_name().unwrap().to_str().unwrap(),
            "photo-ref_jpeg_q75_(-progressive).jpg",
            "产物名 = 原图名_编码器_q质量_(高级参数段)"
        );
        assert_eq!(product.encoding_params, "JPEG（MozJPEG） q75（-progressive）");
        assert!(
            product.command_line.contains("-progressive")
                && product.command_line.contains("-outfile")
                && product.command_line.contains("photo-ref.png"),
            "命令行预览应含完整参数与输入路径: {}",
            product.command_line
        );
        assert_eq!(product.note, None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn advanced_webp_lossless_uses_lossless_flag_and_naming() {
        let dir = std::env::temp_dir().join(format!("pixel-arena-t293-webp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = write_stub_encoder(&dir, "my-cwebp.sh");

        let job = AdvancedImageJob {
            format_id: "webp".to_string(),
            lossless: true,
            mode: AdvancedQuickMode::Quality,
            quality: 75,
            target_bytes: 0,
            rows: vec![],
        };
        let product = encode_advanced_image(
            fixture("photo-ref.png"),
            &job,
            &dir,
            dir.join("tools"),
            &crate::encode::EncoderOverrides {
                cwebp: Some(stub),
                ..Default::default()
            },
            crate::naming::ConflictPolicy::AutoAppend,
        )
        .expect("无损 WebP 高级创建应成功");
        assert!(
            Path::new(&product.path)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .ends_with("_webp_lossless.webp"),
            "无损产物名应带 lossless 质量段: {}",
            product.path
        );
        assert_eq!(product.encoding_params, "WebP（libwebp） 无损");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn advanced_size_mode_writes_actual_quality_point_with_unreachable_note() {
        // 桩产物恒为 5 字节：目标 3 字节过小不可达 → 回退最小质量点 q1 并带标注
        let dir = std::env::temp_dir().join(format!("pixel-arena-t293-size-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = write_stub_encoder(&dir, "my-cjpeg.sh");

        let job = AdvancedImageJob {
            format_id: "jpeg".to_string(),
            lossless: false,
            mode: AdvancedQuickMode::Size,
            quality: 75,
            target_bytes: 3,
            rows: vec![],
        };
        let product = encode_advanced_image(
            fixture("photo-ref.png"),
            &job,
            &dir,
            dir.join("tools"),
            &crate::encode::EncoderOverrides {
                cjpeg: Some(stub),
                ..Default::default()
            },
            crate::naming::ConflictPolicy::AutoAppend,
        )
        .expect("大小优先高级创建应回退到最接近点");
        assert!(
            Path::new(&product.path)
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .contains("_jpeg_q1."),
            "命名应写实际质量点 q1（D8）: {}",
            product.path
        );
        assert_eq!(product.encoding_params, "JPEG（MozJPEG） q1");
        let note = product.note.expect("不可达应带标注");
        assert!(note.contains("不可达"), "{note}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn advanced_flag_conflict_fails_before_encoding() {
        let job = AdvancedImageJob {
            format_id: "jpeg".to_string(),
            lossless: false,
            mode: AdvancedQuickMode::Quality,
            quality: 75,
            target_bytes: 0,
            rows: vec![AdvancedParamRow::new("自定义质量", "-quality", Some("50"))],
        };
        let err = encode_advanced_image(
            fixture("photo-ref.png"),
            &job,
            std::env::temp_dir(),
            std::env::temp_dir(),
            &crate::encode::EncoderOverrides::default(),
            crate::naming::ConflictPolicy::AutoAppend,
        )
        .err()
        .expect("同标志冲突应在编码前报错");
        assert!(err.to_string().contains("-quality"), "{err}");
        // 无损不支持的格式同样在编码前 fail-fast
        let job = AdvancedImageJob {
            format_id: "jpeg".to_string(),
            lossless: true,
            mode: AdvancedQuickMode::Quality,
            quality: 75,
            target_bytes: 0,
            rows: vec![],
        };
        let err = encode_advanced_image(
            fixture("photo-ref.png"),
            &job,
            std::env::temp_dir(),
            std::env::temp_dir(),
            &crate::encode::EncoderOverrides::default(),
            crate::naming::ConflictPolicy::AutoAppend,
        )
        .err()
        .expect("JPEG 无损应报错");
        assert!(err.to_string().contains("无损"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn advanced_product_name_matches_actual_product_and_overwrite_replaces() {
        // 询问策略（T30）的预检名字必须与正式编码落地的名字一字不差；覆盖模式按
        // 确切名落位替换已有文件、不追加 _1、不留暂存残留
        let dir = std::env::temp_dir().join(format!("pixel-arena-t30-adv-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let stub = write_stub_encoder(&dir, "my-cjpeg.sh");
        let out_dir = dir.join("out");
        let job = AdvancedImageJob {
            format_id: "jpeg".to_string(),
            lossless: false,
            mode: AdvancedQuickMode::Quality,
            quality: 60,
            target_bytes: 0,
            rows: vec![],
        };
        let overrides = crate::encode::EncoderOverrides {
            cjpeg: Some(stub),
            ..Default::default()
        };

        let expected = advanced_product_name(
            fixture("photo-ref.png"),
            &job,
            dir.join("tools"),
            &overrides,
        )
        .expect("预检名字应可计算");
        assert_eq!(
            expected, "photo-ref_jpeg_q60.jpg",
            "产物名 = 原图名_编码器_q质量"
        );

        std::fs::create_dir_all(&out_dir).unwrap();
        std::fs::write(out_dir.join(&expected), b"OLD").unwrap();
        let product = encode_advanced_image(
            fixture("photo-ref.png"),
            &job,
            &out_dir,
            dir.join("tools"),
            &overrides,
            crate::naming::ConflictPolicy::Overwrite,
        )
        .expect("覆盖编码应成功");
        assert!(product.path.ends_with(&expected), "覆盖模式应使用确切名: {}", product.path);
        assert_eq!(std::fs::read(&product.path).unwrap(), b"FAKE\n", "已有同名文件应被新产物覆盖");
        assert_eq!(std::fs::read_dir(&out_dir).unwrap().count(), 1, "产物目录应只有覆盖后的产物");
        std::fs::remove_dir_all(&dir).ok();
    }
}
