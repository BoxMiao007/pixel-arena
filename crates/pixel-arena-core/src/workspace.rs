// 跑分组数据模型与 JSON 持久化（T05）。
// 术语以 GLOSSARY.md 为准：跑分组 = Group（一个标签页），评测轮 = Round（组内一次评测）。
// 工作区（Workspace）= 应用保存的全部跑分组状态，序列化为单个 JSON 文件。
//
// 演进约定：JSON 顶层带 format_version；后续给评测轮补「原图/跑分图/结果」等字段时，
// 新字段一律加 #[serde(default)]，保证旧文件仍能加载；本文件不预写用不到的字段。

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use thiserror::Error;

/// JSON 文件格式版本。结构性变更时递增，并在这里写迁移逻辑。
pub const FORMAT_VERSION: u32 = 1;

fn default_format_version() -> u32 {
    FORMAT_VERSION
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    #[serde(default = "default_format_version")]
    pub format_version: u32,
    pub groups: Vec<Group>,
    /// 当前激活的跑分组（界面上选中的标签页）；空工作区为 None。
    #[serde(default)]
    pub active_group_id: Option<String>,
}

/// 跑分组类型（T17）：新建时选定，之后不可更改；组内评测轮的类型随之锁定——
/// 图片跑分组只能装图片评测内容，视频跑分组只能装视频评测内容（见各内容方法的类型校验）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupKind {
    /// 图片跑分组：支持外部导入与一站式两种工作模式。
    #[default]
    Image,
    /// 视频跑分组：仅支持外部导入模式。
    Video,
}

impl GroupKind {
    /// 解析 IPC/前端传来的类型标识（image / video），未知值报中文错误。
    pub fn parse(value: &str) -> Result<Self, WorkspaceError> {
        match value.trim() {
            "image" => Ok(GroupKind::Image),
            "video" => Ok(GroupKind::Video),
            other => Err(WorkspaceError::UnknownGroupKind(other.to_string())),
        }
    }
}

impl std::fmt::Display for GroupKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GroupKind::Image => f.write_str("图片跑分组"),
            GroupKind::Video => f.write_str("视频跑分组"),
        }
    }
}

/// 跑分组：一个标签页承载的独立评测工作单元。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    /// 跑分组类型（T17），新建时选定后不可更改。serde default 只兜底极端坏文件；
    /// 旧文件的类型归类由 `from_json` 的迁移逻辑按组内内容判定，不走这个默认值。
    #[serde(default)]
    pub kind: GroupKind,
    pub rounds: Vec<Round>,
    /// 组内当前激活的评测轮；组存在但还没有轮次时为 None。
    #[serde(default)]
    pub active_round_id: Option<String>,
}

/// 评测轮：跑分组内的一次评测（一张原图/一段原视频 + 若干张跑分图/若干段跑分视频）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Round {
    pub id: String,
    pub name: String,
    /// 原图路径（画质与压缩的基准）。尚未选图时为 None。
    #[serde(default)]
    pub reference_path: Option<String>,
    /// 跑分图列表，含各自的跑分结果。
    #[serde(default)]
    pub candidates: Vec<CandidateImage>,
    /// 原视频路径（视频评测的基准，与原图相互独立，可只用其中一边）。T14 新增。
    #[serde(default)]
    pub video_reference_path: Option<String>,
    /// 跑分视频列表，含各自的跑分结果。T14 新增。
    #[serde(default)]
    pub video_candidates: Vec<CandidateVideo>,
}

/// 评测轮内容里的一张跑分图及其跑分结果。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateImage {
    /// 跑分图文件路径（绝对路径）。
    pub path: String,
    /// 文件大小（字节），选入时从磁盘读取。
    pub file_size: u64,
    /// 相对原图的体积比（跑分图大小 / 原图大小）。未选原图前未知。
    #[serde(default)]
    pub size_ratio: Option<f64>,
    /// 跑分结果：指标名 → 值。结果表的指标列由这里的键驱动，
    /// T04 新增指标（MS-SSIM / Butteraugli / SSIMULACRA2）时结果表自动多列。
    /// 未跑分或跑分失败时为 None。
    #[serde(default)]
    pub metrics: Option<BTreeMap<String, MetricValue>>,
    /// 编码参数文本（如 "JPEG q75"、"PNG 无损"），一站式模式写入；外部导入模式
    /// 为 None（参数用户自备，工具不知晓），界面与报告显示 —。
    #[serde(default)]
    pub encoding_params: Option<String>,
    /// 跑分失败原因（中文，可直接展示）。成功或未跑分时为 None。
    #[serde(default)]
    pub error: Option<String>,
}

/// 评测轮内容里的一段跑分视频及其跑分结果（T14）。字段语义与 [`CandidateImage`] 一致。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateVideo {
    /// 跑分视频文件路径（绝对路径）。
    pub path: String,
    /// 文件大小（字节），选入时从磁盘读取。
    pub file_size: u64,
    /// 相对原视频的体积比（跑分视频大小 / 原视频大小）。未选原视频前未知。
    #[serde(default)]
    pub size_ratio: Option<f64>,
    /// 跑分结果：指标名 → 值（VMAF / PSNR / SSIM）。未跑分或失败时为 None。
    #[serde(default)]
    pub metrics: Option<BTreeMap<String, MetricValue>>,
    /// 编码参数文本（语义与 [`CandidateImage::encoding_params`] 一致；视频一站式
    /// 属第二版路线图，当前流程不会写入，字段先行保证两侧数据模型同构）。
    #[serde(default)]
    pub encoding_params: Option<String>,
    /// 跑分失败原因（中文，可直接展示）。成功或未跑分时为 None。
    #[serde(default)]
    pub error: Option<String>,
    /// 本对跑分耗时（毫秒，含 ffmpeg 子进程）。未跑分时为 None；失败也会记录已耗时。
    #[serde(default)]
    pub elapsed_ms: Option<u64>,
}

/// 单个指标值：有限数值，或无穷大（两图逐像素完全一致时 PSNR 的情形）。
///
/// JSON 数字表达不了无穷大，且 serde_json 会把非有限浮点写成 null（读不回来），
/// 所以无穷大以字符串 `"inf"` 哨兵持久化；其余字符串是坏数据，反序列化直接报错。
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MetricValue {
    Number(f64),
    Inf,
}

impl MetricValue {
    /// 从 f64 构造：无穷大自动落为 [`MetricValue::Inf`] 哨兵。
    pub fn new(value: f64) -> Self {
        if value.is_infinite() {
            MetricValue::Inf
        } else {
            MetricValue::Number(value)
        }
    }

    /// 数值形式（Inf 即 f64::INFINITY），排序与格式化用。
    pub fn value(&self) -> f64 {
        match self {
            MetricValue::Number(v) => *v,
            MetricValue::Inf => f64::INFINITY,
        }
    }
}

impl Serialize for MetricValue {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            MetricValue::Number(v) => serializer.serialize_f64(*v),
            MetricValue::Inf => serializer.serialize_str("inf"),
        }
    }
}

impl<'de> Deserialize<'de> for MetricValue {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl serde::de::Visitor<'_> for Visitor {
            type Value = MetricValue;
            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("指标数值或 \"inf\" 哨兵")
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<Self::Value, E> {
                Ok(MetricValue::new(v))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<Self::Value, E> {
                Ok(MetricValue::Number(v as f64))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<Self::Value, E> {
                Ok(MetricValue::Number(v as f64))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<Self::Value, E> {
                if v == "inf" {
                    Ok(MetricValue::Inf)
                } else {
                    Err(E::invalid_value(serde::de::Unexpected::Str(v), &self))
                }
            }
        }
        deserializer.deserialize_any(Visitor)
    }
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("跑分组不存在: {0}")]
    GroupNotFound(String),
    #[error("评测轮不存在: {0}")]
    RoundNotFound(String),
    #[error("跑分图不存在: {0}")]
    CandidateNotFound(String),
    #[error("跑分视频不存在: {0}")]
    VideoCandidateNotFound(String),
    #[error("尚未选择原图，无法跑分")]
    ReferenceNotSet,
    #[error("尚未选择原视频，无法跑分")]
    VideoReferenceNotSet,
    #[error("跑分组类型不符：{0}内不能进行{1}评测操作")]
    GroupKindMismatch(GroupKind, GroupKind),
    #[error("未知的跑分组类型: {0}（支持 image / video）")]
    UnknownGroupKind(String),
    #[error("名称不能为空")]
    BlankName,
    #[error("JSON 解析失败: {0}")]
    JsonParse(#[from] serde_json::Error),
    #[error("工作区文件版本不受支持: v{0}（本应用支持 v{1}）")]
    UnsupportedVersion(u32, u32),
    #[error("读写工作区文件失败: {0}")]
    Io(#[from] std::io::Error),
}

impl Workspace {
    pub fn new() -> Self {
        Workspace {
            format_version: FORMAT_VERSION,
            groups: Vec::new(),
            active_group_id: None,
        }
    }

    /// 新建跑分组并把它设为激活组（界面上新标签页立即选中）。名称首尾空白会被去除。
    /// 类型（图片/视频）在创建时选定，之后没有修改类型的入口。
    pub fn create_group(
        &mut self,
        name: &str,
        kind: GroupKind,
    ) -> Result<&Group, WorkspaceError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WorkspaceError::BlankName);
        }
        let group = Group {
            id: new_id("g"),
            name: name.to_string(),
            kind,
            rounds: Vec::new(),
            active_round_id: None,
        };
        self.active_group_id = Some(group.id.clone());
        self.groups.push(group);
        Ok(self.groups.last().expect("刚 push 过，必有元素"))
    }

    /// 取跑分组，找不到时返回错误。
    fn group_mut(&mut self, group_id: &str) -> Result<&mut Group, WorkspaceError> {
        self.groups
            .iter_mut()
            .find(|g| g.id == group_id)
            .ok_or_else(|| WorkspaceError::GroupNotFound(group_id.to_string()))
    }

    /// 取组内的评测轮，组或轮找不到时返回错误。
    fn round_mut(&mut self, group_id: &str, round_id: &str) -> Result<&mut Round, WorkspaceError> {
        self.group_mut(group_id)?
            .rounds
            .iter_mut()
            .find(|r| r.id == round_id)
            .ok_or_else(|| WorkspaceError::RoundNotFound(round_id.to_string()))
    }

    /// T17 类型锁定：校验跑分组类型与即将进行的评测操作匹配（图片组只收图片内容、
    /// 视频组只收视频内容），组内新建评测轮的类型因此随组固定。放在各内容方法的
    /// 第一步，错误先于任何内存变更与磁盘读取抛出。
    fn ensure_group_kind(&self, group_id: &str, wanted: GroupKind) -> Result<(), WorkspaceError> {
        let group = self
            .groups
            .iter()
            .find(|g| g.id == group_id)
            .ok_or_else(|| WorkspaceError::GroupNotFound(group_id.to_string()))?;
        if group.kind != wanted {
            return Err(WorkspaceError::GroupKindMismatch(group.kind, wanted));
        }
        Ok(())
    }

    /// 选入原图（外部导入模式：从文件对话框选一张原图，可重复选换图）。
    ///
    /// 换原图时旧跑分结果都是相对旧原图算的，连同体积比、失败原因一起作废；
    /// 已在列表里的跑分图按新原图重算体积比。原图文件必须存在（fail-fast）。
    pub fn set_round_reference(
        &mut self,
        group_id: &str,
        round_id: &str,
        path: &str,
    ) -> Result<(), WorkspaceError> {
        self.ensure_group_kind(group_id, GroupKind::Image)?;
        let path = path.trim();
        let reference_size = std::fs::metadata(path)?.len();

        let round = self.round_mut(group_id, round_id)?;
        round.reference_path = Some(path.to_string());
        for candidate in &mut round.candidates {
            candidate.metrics = None;
            candidate.error = None;
            candidate.size_ratio = Some(candidate.file_size as f64 / reference_size as f64);
        }
        Ok(())
    }

    /// 把若干张跑分图加入评测轮（外部导入模式的多选）。
    ///
    /// 文件大小选入时从磁盘读取；已在列表里的路径跳过（重复选同一张不产生重复行）。
    /// 任一文件不存在时整批失败、不落半批（fail-fast）。外部导入的编码参数用户自备、
    /// 工具不知晓，`encoding_params` 传 None（一站式模式传与 `paths` 等长的参数表，
    /// 见 [`Workspace::add_round_candidates_with_params`]）。
    pub fn add_round_candidates(
        &mut self,
        group_id: &str,
        round_id: &str,
        paths: &[&str],
    ) -> Result<(), WorkspaceError> {
        self.add_round_candidates_with_params(group_id, round_id, paths, None)
    }

    /// [`Workspace::add_round_candidates`] 的带参数版（一站式模式）：
    /// `encoding_params` 与 `paths` 一一对应（如 "JPEG q75"），长度不足的尾部按
    /// None 处理。重复路径跳过时保留行内原有参数（重复触发幂等）。
    pub fn add_round_candidates_with_params(
        &mut self,
        group_id: &str,
        round_id: &str,
        paths: &[&str],
        encoding_params: Option<&[Option<String>]>,
    ) -> Result<(), WorkspaceError> {
        self.ensure_group_kind(group_id, GroupKind::Image)?;
        let round = self.round_mut(group_id, round_id)?;
        let reference_size = match &round.reference_path {
            Some(reference) => Some(std::fs::metadata(reference)?.len()),
            None => None,
        };

        // 先全部读盘校验，确认无误再改内存
        let mut fresh: Vec<CandidateImage> = Vec::new();
        for (index, path) in paths.iter().enumerate() {
            let path = path.trim();
            let already = round.candidates.iter().any(|c| c.path == path)
                || fresh.iter().any(|c| c.path == path);
            if already {
                continue;
            }
            let file_size = std::fs::metadata(path)?.len();
            fresh.push(CandidateImage {
                path: path.to_string(),
                file_size,
                size_ratio: reference_size.map(|r| file_size as f64 / r as f64),
                metrics: None,
                encoding_params: encoding_params
                    .and_then(|params| params.get(index))
                    .cloned()
                    .flatten(),
                error: None,
            });
        }
        round.candidates.extend(fresh);
        Ok(())
    }

    /// 对一张跑分图跑分（计算相对原图的质量指标），结果写回该跑分图所在行。
    ///
    /// 单张失败（打不开、解不了码、尺寸不一致）不让整轮失败：中文原因写进行内
    /// 的 error 字段，由界面标「失败」；只有找不到组/轮/跑分图或没选原图才返回错误。
    pub fn score_round_candidate(
        &mut self,
        group_id: &str,
        round_id: &str,
        candidate_path: &str,
    ) -> Result<(), WorkspaceError> {
        // 先只读定位，确认前置条件都成立（错误先于任何内存变更抛出）
        self.ensure_group_kind(group_id, GroupKind::Image)?;
        let reference_path = {
            let round = self.round_mut(group_id, round_id)?;
            let reference = round
                .reference_path
                .clone()
                .ok_or(WorkspaceError::ReferenceNotSet)?;
            if !round.candidates.iter().any(|c| c.path == candidate_path) {
                return Err(WorkspaceError::CandidateNotFound(candidate_path.to_string()));
            }
            reference
        };

        // 跑分可能耗时（大图 SSIM 秒级），不持有工作区借用
        let result = crate::metrics::score_images(&reference_path, candidate_path);

        let candidate = self
            .round_mut(group_id, round_id)?
            .candidates
            .iter_mut()
            .find(|c| c.path == candidate_path)
            .expect("上面刚确认过跑分图在列表里");
        match result {
            Ok(metrics) => {
                // 全部五指标入库（T04 兑现）：结果表与导出报告的数据列由此驱动，
                // 键名与 report.rs 的 IMAGE_METRIC_KEYS / 旧工作区文件保持一致
                candidate.metrics = Some(BTreeMap::from([
                    ("PSNR".to_string(), MetricValue::new(metrics.psnr)),
                    ("SSIM".to_string(), MetricValue::new(metrics.ssim)),
                    ("MS-SSIM".to_string(), MetricValue::new(metrics.ms_ssim)),
                    ("Butteraugli".to_string(), MetricValue::new(metrics.butteraugli)),
                    ("SSIMULACRA2".to_string(), MetricValue::new(metrics.ssimulacra2)),
                ]));
                candidate.error = None;
            }
            Err(err) => {
                candidate.metrics = None;
                candidate.error = Some(err.to_string());
            }
        }
        Ok(())
    }

    // ---------- T14：视频评测轮（原视频 / 跑分视频 / VMAF-PSNR-SSIM） ----------
    // 语义与图片侧三个方法一一对应；跑分需要调用方传入含 libvmaf 滤镜的 ffmpeg 路径。

    /// 选入原视频（可重复选换视频）。换视频时旧跑分结果与体积比一并作废；
    /// 已在列表里的跑分视频按新原视频重算体积比。原视频文件必须存在（fail-fast）。
    pub fn set_round_video_reference(
        &mut self,
        group_id: &str,
        round_id: &str,
        path: &str,
    ) -> Result<(), WorkspaceError> {
        self.ensure_group_kind(group_id, GroupKind::Video)?;
        let path = path.trim();
        let reference_size = std::fs::metadata(path)?.len();

        let round = self.round_mut(group_id, round_id)?;
        round.video_reference_path = Some(path.to_string());
        for candidate in &mut round.video_candidates {
            candidate.metrics = None;
            candidate.error = None;
            candidate.elapsed_ms = None;
            candidate.size_ratio = Some(candidate.file_size as f64 / reference_size as f64);
        }
        Ok(())
    }

    /// 把若干段跑分视频加入评测轮（外部导入模式的多选）。
    /// 文件大小选入时从磁盘读取；重复路径跳过；任一文件不存在时整批失败（fail-fast）。
    pub fn add_round_video_candidates(
        &mut self,
        group_id: &str,
        round_id: &str,
        paths: &[&str],
    ) -> Result<(), WorkspaceError> {
        self.ensure_group_kind(group_id, GroupKind::Video)?;
        let round = self.round_mut(group_id, round_id)?;
        let reference_size = match &round.video_reference_path {
            Some(reference) => Some(std::fs::metadata(reference)?.len()),
            None => None,
        };

        // 先全部读盘校验，确认无误再改内存
        let mut fresh: Vec<CandidateVideo> = Vec::new();
        for path in paths {
            let path = path.trim();
            let already = round.video_candidates.iter().any(|c| c.path == path)
                || fresh.iter().any(|c| c.path == path);
            if already {
                continue;
            }
            let file_size = std::fs::metadata(path)?.len();
            fresh.push(CandidateVideo {
                path: path.to_string(),
                file_size,
                size_ratio: reference_size.map(|r| file_size as f64 / r as f64),
                metrics: None,
                encoding_params: None,
                error: None,
                elapsed_ms: None,
            });
        }
        round.video_candidates.extend(fresh);
        Ok(())
    }

    /// 对一段跑分视频跑分（经 ffmpeg 计算 VMAF/PSNR/SSIM 相对原视频），结果写回该行。
    ///
    /// 单段失败不让整轮失败：中文原因写进行内 error 字段并记录已耗时；只有找不到
    /// 组/轮/跑分视频或没选原视频才返回错误。`ffmpeg` 须指向含 libvmaf 滤镜的可执行文件。
    pub fn score_round_video_candidate(
        &mut self,
        group_id: &str,
        round_id: &str,
        candidate_path: &str,
        ffmpeg: &std::path::Path,
    ) -> Result<(), WorkspaceError> {
        // 先只读定位，确认前置条件都成立（错误先于任何内存变更抛出）
        self.ensure_group_kind(group_id, GroupKind::Video)?;
        let reference_path = {
            let round = self.round_mut(group_id, round_id)?;
            let reference = round
                .video_reference_path
                .clone()
                .ok_or(WorkspaceError::VideoReferenceNotSet)?;
            if !round.video_candidates.iter().any(|c| c.path == candidate_path) {
                return Err(WorkspaceError::VideoCandidateNotFound(
                    candidate_path.to_string(),
                ));
            }
            reference
        };

        // ffmpeg 跑分可能耗时（长视频分钟级），不持有工作区借用
        let started = std::time::Instant::now();
        let result = crate::video::score_videos(ffmpeg, &reference_path, candidate_path);
        let elapsed_ms = started.elapsed().as_millis() as u64;

        let candidate = self
            .round_mut(group_id, round_id)?
            .video_candidates
            .iter_mut()
            .find(|c| c.path == candidate_path)
            .expect("上面刚确认过跑分视频在列表里");
        match result {
            Ok(metrics) => {
                candidate.metrics = Some(BTreeMap::from([
                    ("VMAF".to_string(), MetricValue::new(metrics.vmaf)),
                    ("PSNR".to_string(), MetricValue::new(metrics.psnr)),
                    ("SSIM".to_string(), MetricValue::new(metrics.ssim)),
                ]));
                candidate.error = None;
            }
            Err(err) => {
                candidate.metrics = None;
                candidate.error = Some(err.to_string());
            }
        }
        candidate.elapsed_ms = Some(elapsed_ms);
        Ok(())
    }

    /// 重命名跑分组。名称首尾空白会被去除。
    pub fn rename_group(&mut self, group_id: &str, name: &str) -> Result<(), WorkspaceError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WorkspaceError::BlankName);
        }
        self.group_mut(group_id)?.name = name.to_string();
        Ok(())
    }

    /// 关闭（删除）跑分组，连同组内全部评测轮。
    /// 若关闭的是激活组，激活组右移一格（无右邻则左移，空工作区为 None）。
    pub fn close_group(&mut self, group_id: &str) -> Result<(), WorkspaceError> {
        let index = self
            .groups
            .iter()
            .position(|g| g.id == group_id)
            .ok_or_else(|| WorkspaceError::GroupNotFound(group_id.to_string()))?;
        self.groups.remove(index);
        let was_active = self.active_group_id.as_deref() == Some(group_id);
        if was_active {
            self.active_group_id = self
                .groups
                .get(index)
                .or_else(|| index.checked_sub(1).and_then(|i| self.groups.get(i)))
                .map(|g| g.id.clone());
        }
        Ok(())
    }

    /// 激活某个跑分组（界面上切换标签页）。
    pub fn activate_group(&mut self, group_id: &str) -> Result<(), WorkspaceError> {
        if !self.groups.iter().any(|g| g.id == group_id) {
            return Err(WorkspaceError::GroupNotFound(group_id.to_string()));
        }
        self.active_group_id = Some(group_id.to_string());
        Ok(())
    }

    /// 在跑分组内新建评测轮并把它设为该组激活轮。名称首尾空白会被去除。
    pub fn create_round(
        &mut self,
        group_id: &str,
        name: &str,
    ) -> Result<&Round, WorkspaceError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WorkspaceError::BlankName);
        }
        let group = self.group_mut(group_id)?;
        let round = Round {
            id: new_id("r"),
            name: name.to_string(),
            reference_path: None,
            candidates: Vec::new(),
            video_reference_path: None,
            video_candidates: Vec::new(),
        };
        group.active_round_id = Some(round.id.clone());
        group.rounds.push(round);
        Ok(group.rounds.last().expect("刚 push 过，必有元素"))
    }

    /// 重命名评测轮。名称首尾空白会被去除。
    pub fn rename_round(
        &mut self,
        group_id: &str,
        round_id: &str,
        name: &str,
    ) -> Result<(), WorkspaceError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WorkspaceError::BlankName);
        }
        let group = self.group_mut(group_id)?;
        let round = group
            .rounds
            .iter_mut()
            .find(|r| r.id == round_id)
            .ok_or_else(|| WorkspaceError::RoundNotFound(round_id.to_string()))?;
        round.name = name.to_string();
        Ok(())
    }

    /// 删除评测轮。若删除的是激活轮，激活轮右移一格（无右邻则左移，组内无轮时为 None）。
    pub fn delete_round(&mut self, group_id: &str, round_id: &str) -> Result<(), WorkspaceError> {
        let group = self.group_mut(group_id)?;
        let index = group
            .rounds
            .iter()
            .position(|r| r.id == round_id)
            .ok_or_else(|| WorkspaceError::RoundNotFound(round_id.to_string()))?;
        group.rounds.remove(index);
        let was_active = group.active_round_id.as_deref() == Some(round_id);
        if was_active {
            group.active_round_id = group
                .rounds
                .get(index)
                .or_else(|| index.checked_sub(1).and_then(|i| group.rounds.get(i)))
                .map(|r| r.id.clone());
        }
        Ok(())
    }

    /// 激活组内某个评测轮（界面上切换轮次）。
    pub fn activate_round(
        &mut self,
        group_id: &str,
        round_id: &str,
    ) -> Result<(), WorkspaceError> {
        let group = self.group_mut(group_id)?;
        if !group.rounds.iter().any(|r| r.id == round_id) {
            return Err(WorkspaceError::RoundNotFound(round_id.to_string()));
        }
        group.active_round_id = Some(round_id.to_string());
        Ok(())
    }

    /// 序列化为 JSON（自动保存与 CLI 复用）。
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("Workspace 序列化不会失败")
    }

    /// 从 JSON 反序列化。校验格式版本，未来版本拒绝加载（fail-fast，不做猜测式迁移）。
    ///
    /// T17 迁移：旧文件的组没有 kind 字段，加载时按「组内任一轮含视频 → 视频跑分组，
    /// 否则（含空组）→ 图片跑分组」归类，老数据无损；已带 kind 的组不动
    ///（新建的空视频跑分组不会被翻回图片）。
    pub fn from_json(json: &str) -> Result<Self, WorkspaceError> {
        let raw: serde_json::Value = serde_json::from_str(json)?;
        let version = raw
            .get("formatVersion")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(FORMAT_VERSION as u64);
        if version != FORMAT_VERSION as u64 {
            return Err(WorkspaceError::UnsupportedVersion(
                version as u32,
                FORMAT_VERSION,
            ));
        }
        // 反序列化前先记下哪些组缺 kind 字段（serde default 会把缺字段兜成 Image，
        // 之后再分不出「缺字段」和「明确是图片」，所以要在原始 JSON 上判一次）
        let missing_kind: Vec<bool> = raw
            .get("groups")
            .and_then(serde_json::Value::as_array)
            .map(|groups| groups.iter().map(|g| g.get("kind").is_none()).collect())
            .unwrap_or_default();
        let mut ws: Workspace = serde_json::from_value(raw)?;
        for (group, missing) in ws.groups.iter_mut().zip(missing_kind) {
            if missing {
                group.kind = if group.rounds.iter().any(|round| {
                    round.video_reference_path.is_some() || !round.video_candidates.is_empty()
                }) {
                    GroupKind::Video
                } else {
                    GroupKind::Image
                };
            }
        }
        Ok(ws)
    }

    /// 保存到文件：先写临时文件再原子重命名，中途崩溃不会留下半截 JSON。
    pub fn save_to_file(&self, path: &std::path::Path) -> Result<(), WorkspaceError> {
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, self.to_json())?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// 从文件加载。文件不存在时返回 IO 错误，由调用方决定是否回落到空工作区。
    pub fn load_from_file(path: &std::path::Path) -> Result<Self, WorkspaceError> {
        let json = std::fs::read_to_string(path)?;
        Self::from_json(&json)
    }
}

impl Default for Workspace {
    fn default() -> Self {
        Self::new()
    }
}

/// 生成进程内唯一的短 ID（时间戳纳秒 + 计数器），只在单个工作区文件内要求唯一。
fn new_id(prefix: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let seq = COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{prefix}-{nanos:x}-{seq}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_workspace_is_empty() {
        let ws = Workspace::new();
        assert!(ws.groups.is_empty());
        assert_eq!(ws.active_group_id, None);
    }

    #[test]
    fn create_group_adds_named_group_and_activates_it() {
        let mut ws = Workspace::new();
        ws.create_group("人像测试", GroupKind::Image).unwrap();
        assert_eq!(ws.groups.len(), 1);
        assert_eq!(ws.groups[0].name, "人像测试");
        assert!(!ws.groups[0].id.is_empty());
        assert_eq!(ws.active_group_id.as_deref(), Some(ws.groups[0].id.as_str()));
    }

    #[test]
    fn create_group_rejects_blank_name() {
        let mut ws = Workspace::new();
        assert!(ws.create_group("   ", GroupKind::Image).is_err());
        assert!(ws.groups.is_empty());
    }

    // ---------- T17：跑分组类型（图片/视频，新建时选定） ----------

    #[test]
    fn create_group_stores_kind_and_persists_camel_case() {
        let mut ws = Workspace::new();
        ws.create_group("人像测试", GroupKind::Image).unwrap();
        ws.create_group("视频对比", GroupKind::Video).unwrap();
        assert_eq!(ws.groups[0].kind, GroupKind::Image);
        assert_eq!(ws.groups[1].kind, GroupKind::Video);
        // camelCase 键名 kind，值为小写 image / video
        let json = ws.to_json();
        assert!(json.contains("\"kind\": \"image\""), "JSON 键名: {json}");
        assert!(json.contains("\"kind\": \"video\""), "JSON 键名: {json}");
        // JSON 往返后类型保持（含空的视频跑分组：迁移不得把它翻回图片）
        let restored = Workspace::from_json(&json).unwrap();
        assert_eq!(restored.groups[0].kind, GroupKind::Image);
        assert_eq!(restored.groups[1].kind, GroupKind::Video);
    }

    #[test]
    fn group_kind_parse_accepts_image_and_video_only() {
        assert_eq!(GroupKind::parse("image").unwrap(), GroupKind::Image);
        assert_eq!(GroupKind::parse(" video ").unwrap(), GroupKind::Video);
        assert!(matches!(
            GroupKind::parse("图片"),
            Err(WorkspaceError::UnknownGroupKind(_))
        ));
    }

    // ---------- T17：旧工作区迁移（组无 kind 字段 → 按组内内容归类，数据无损） ----------

    #[test]
    fn old_workspace_empty_group_migrates_to_image() {
        // 旧文件：组没有 kind 字段且没有评测轮（空组）→ 图片跑分组
        let old = r#"{
            "formatVersion": 1,
            "groups": [{"id": "g-1", "name": "空组", "rounds": []}]
        }"#;
        let ws = Workspace::from_json(old).unwrap();
        assert_eq!(ws.groups[0].kind, GroupKind::Image);
    }

    #[test]
    fn old_workspace_image_only_group_migrates_to_image() {
        // 旧文件：评测轮只有图片评测内容 → 图片跑分组
        let old = r#"{
            "formatVersion": 1,
            "groups": [{
                "id": "g-1", "name": "人像测试",
                "rounds": [{
                    "id": "r-1", "name": "轮",
                    "referencePath": "/tmp/ref.png",
                    "candidates": [{"path": "/tmp/dis.jpg", "fileSize": 17341}]
                }]
            }]
        }"#;
        let ws = Workspace::from_json(old).unwrap();
        assert_eq!(ws.groups[0].kind, GroupKind::Image);
    }

    #[test]
    fn old_workspace_group_with_video_round_migrates_to_video() {
        // 旧文件：任一轮含视频（有原视频或有跑分视频）→ 视频跑分组；两种形态都覆盖
        let old = r#"{
            "formatVersion": 1,
            "groups": [{
                "id": "g-1", "name": "视频对比",
                "rounds": [
                    {"id": "r-1", "name": "只有原视频", "videoReferencePath": "/tmp/ref.mp4"},
                    {"id": "r-2", "name": "只有跑分视频",
                     "videoCandidates": [{"path": "/tmp/dis.mp4", "fileSize": 27050}]}
                ]
            }]
        }"#;
        let ws = Workspace::from_json(old).unwrap();
        assert_eq!(ws.groups[0].kind, GroupKind::Video);
    }

    #[test]
    fn old_workspace_mixed_group_with_video_migrates_to_video_and_keeps_data() {
        // 旧文件：同一轮图片+视频混用（分类型之前允许）→ 按规则归视频跑分组；
        // 迁移只补类型，组/轮/结果一字不丢
        let old = r#"{
            "formatVersion": 1,
            "activeGroupId": "g-1",
            "groups": [{
                "id": "g-1", "name": "混用组",
                "activeRoundId": "r-1",
                "rounds": [{
                    "id": "r-1", "name": "混用轮",
                    "referencePath": "/tmp/ref.png",
                    "candidates": [{"path": "/tmp/dis.jpg", "fileSize": 17341,
                                    "metrics": {"PSNR": 27.5}}],
                    "videoReferencePath": "/tmp/ref.mp4",
                    "videoCandidates": [{"path": "/tmp/dis.mp4", "fileSize": 27050}]
                }]
            }]
        }"#;
        let ws = Workspace::from_json(old).unwrap();
        assert_eq!(ws.groups[0].kind, GroupKind::Video);
        let round = &ws.groups[0].rounds[0];
        assert_eq!(round.reference_path.as_deref(), Some("/tmp/ref.png"));
        assert_eq!(round.candidates[0].file_size, 17341);
        assert_eq!(
            round.candidates[0].metrics.as_ref().unwrap()["PSNR"],
            MetricValue::Number(27.5)
        );
        assert_eq!(round.video_reference_path.as_deref(), Some("/tmp/ref.mp4"));
        assert_eq!(round.video_candidates[0].file_size, 27050);
        assert_eq!(ws.groups[0].active_round_id.as_deref(), Some("r-1"));
        assert_eq!(ws.active_group_id.as_deref(), Some("g-1"));
    }

    // ---------- T17：类型锁定（组内评测轮只能进行本类型的评测操作） ----------

    #[test]
    fn video_group_rejects_image_round_content() {
        let mut ws = Workspace::new();
        let g = ws
            .create_group("视频对比", GroupKind::Video)
            .unwrap()
            .id
            .clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        // 新建评测轮的类型随组锁定为视频：选原图 / 添加跑分图 / 图片跑分都被拒绝
        assert!(matches!(
            ws.set_round_reference(&g, &r, &data("photo-ref.png")),
            Err(WorkspaceError::GroupKindMismatch(
                GroupKind::Video,
                GroupKind::Image
            ))
        ));
        assert!(matches!(
            ws.add_round_candidates(&g, &r, &[&data("photo-dis.jpg")]),
            Err(WorkspaceError::GroupKindMismatch(
                GroupKind::Video,
                GroupKind::Image
            ))
        ));
        assert!(matches!(
            ws.score_round_candidate(&g, &r, &data("photo-dis.jpg")),
            Err(WorkspaceError::GroupKindMismatch(
                GroupKind::Video,
                GroupKind::Image
            ))
        ));
        // 拒绝后轮内没有落下任何图片内容
        assert_eq!(ws.groups[0].rounds[0].reference_path, None);
        assert!(ws.groups[0].rounds[0].candidates.is_empty());
    }

    #[test]
    fn image_group_rejects_video_round_content() {
        let mut ws = Workspace::new();
        let g = ws
            .create_group("人像测试", GroupKind::Image)
            .unwrap()
            .id
            .clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        // 新建评测轮的类型随组锁定为图片：选原视频 / 添加跑分视频 / 视频跑分都被拒绝
        assert!(matches!(
            ws.set_round_video_reference(&g, &r, &video_data("video-ref-500k.mp4")),
            Err(WorkspaceError::GroupKindMismatch(
                GroupKind::Image,
                GroupKind::Video
            ))
        ));
        assert!(matches!(
            ws.add_round_video_candidates(&g, &r, &[&video_data("video-dis-150k.mp4")]),
            Err(WorkspaceError::GroupKindMismatch(
                GroupKind::Image,
                GroupKind::Video
            ))
        ));
        assert!(matches!(
            ws.score_round_video_candidate(
                &g,
                &r,
                &video_data("video-dis-150k.mp4"),
                std::path::Path::new("ffmpeg"),
            ),
            Err(WorkspaceError::GroupKindMismatch(
                GroupKind::Image,
                GroupKind::Video
            ))
        ));
        // 拒绝后轮内没有落下任何视频内容
        assert_eq!(ws.groups[0].rounds[0].video_reference_path, None);
        assert!(ws.groups[0].rounds[0].video_candidates.is_empty());
    }

    #[test]
    fn kind_check_keeps_existing_error_paths() {
        // 组不存在时仍报 GroupNotFound（类型校验在定位之后，不改变既有错误语义）
        let mut ws = Workspace::new();
        assert!(matches!(
            ws.set_round_reference("不存在", "r-1", "/tmp/x.png"),
            Err(WorkspaceError::GroupNotFound(_))
        ));
        assert!(matches!(
            ws.set_round_video_reference("不存在", "r-1", "/tmp/x.mp4"),
            Err(WorkspaceError::GroupNotFound(_))
        ));
    }

    #[test]
    fn rename_group_updates_name() {
        let mut ws = Workspace::new();
        let g = ws.create_group("旧名", GroupKind::Image).unwrap().id.clone();
        ws.rename_group(&g, "人像测试").unwrap();
        assert_eq!(ws.groups[0].name, "人像测试");
    }

    #[test]
    fn rename_group_rejects_blank_and_missing() {
        let mut ws = Workspace::new();
        let g = ws.create_group("甲", GroupKind::Image).unwrap().id.clone();
        assert!(matches!(
            ws.rename_group(&g, "  "),
            Err(WorkspaceError::BlankName)
        ));
        assert!(matches!(
            ws.rename_group("不存在", "乙"),
            Err(WorkspaceError::GroupNotFound(_))
        ));
    }

    #[test]
    fn close_group_removes_it_and_activates_neighbor() {
        let mut ws = Workspace::new();
        let a = ws.create_group("甲", GroupKind::Image).unwrap().id.clone();
        let b = ws.create_group("乙", GroupKind::Image).unwrap().id.clone();
        let c = ws.create_group("丙", GroupKind::Image).unwrap().id.clone();
        // 关闭中间的乙（此时激活组是乙），激活组应落到右邻丙
        ws.close_group(&b).unwrap();
        assert_eq!(ws.groups.len(), 2);
        assert_eq!(ws.active_group_id.as_deref(), Some(c.as_str()));
        // 再关闭右邻丙，激活组落到左邻甲
        ws.close_group(&c).unwrap();
        assert_eq!(ws.active_group_id.as_deref(), Some(a.as_str()));
        // 关闭最后一个组，无激活组
        ws.close_group(&a).unwrap();
        assert!(ws.groups.is_empty());
        assert_eq!(ws.active_group_id, None);
    }

    #[test]
    fn close_group_keeps_active_when_closing_other_tab() {
        let mut ws = Workspace::new();
        let a = ws.create_group("甲", GroupKind::Image).unwrap().id.clone();
        let b = ws.create_group("乙", GroupKind::Image).unwrap().id.clone();
        ws.activate_group(&a).unwrap();
        ws.close_group(&b).unwrap();
        assert_eq!(ws.active_group_id.as_deref(), Some(a.as_str()));
        assert!(matches!(
            ws.close_group("不存在"),
            Err(WorkspaceError::GroupNotFound(_))
        ));
    }

    #[test]
    fn create_round_adds_named_round_and_activates_it() {
        let mut ws = Workspace::new();
        let g = ws.create_group("人像测试", GroupKind::Image).unwrap().id.clone();
        let r = ws.create_round(&g, "风景原图").unwrap().id.clone();
        assert_eq!(ws.groups[0].rounds.len(), 1);
        assert_eq!(ws.groups[0].rounds[0].name, "风景原图");
        assert_eq!(ws.groups[0].active_round_id.as_deref(), Some(r.as_str()));
        // 空名 / 不存在的组都报错
        assert!(matches!(
            ws.create_round(&g, " "),
            Err(WorkspaceError::BlankName)
        ));
        assert!(matches!(
            ws.create_round("不存在", "甲"),
            Err(WorkspaceError::GroupNotFound(_))
        ));
    }

    #[test]
    fn rename_round_updates_name() {
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Image).unwrap().id.clone();
        let r = ws.create_round(&g, "旧名").unwrap().id.clone();
        ws.rename_round(&g, &r, "新名").unwrap();
        assert_eq!(ws.groups[0].rounds[0].name, "新名");
        assert!(matches!(
            ws.rename_round(&g, "不存在", "名"),
            Err(WorkspaceError::RoundNotFound(_))
        ));
    }

    #[test]
    fn delete_round_activates_neighbor_or_none() {
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Image).unwrap().id.clone();
        let r1 = ws.create_round(&g, "轮1").unwrap().id.clone();
        let r2 = ws.create_round(&g, "轮2").unwrap().id.clone();
        let r3 = ws.create_round(&g, "轮3").unwrap().id.clone();
        // 删中间轮2（激活中），激活轮右移到轮3
        ws.delete_round(&g, &r2).unwrap();
        assert_eq!(ws.groups[0].rounds.len(), 2);
        assert_eq!(ws.groups[0].active_round_id.as_deref(), Some(r3.as_str()));
        // 删右邻轮3，激活轮左移到轮1
        ws.delete_round(&g, &r3).unwrap();
        assert_eq!(ws.groups[0].active_round_id.as_deref(), Some(r1.as_str()));
        // 删最后一轮，组内无激活轮
        ws.delete_round(&g, &r1).unwrap();
        assert!(ws.groups[0].rounds.is_empty());
        assert_eq!(ws.groups[0].active_round_id, None);
        // 不存在的轮/组
        assert!(matches!(
            ws.delete_round(&g, "不存在"),
            Err(WorkspaceError::RoundNotFound(_))
        ));
        assert!(matches!(
            ws.delete_round("不存在", &r1),
            Err(WorkspaceError::GroupNotFound(_))
        ));
    }

    #[test]
    fn activate_round_and_activate_group_switch_selection() {
        let mut ws = Workspace::new();
        let g1 = ws.create_group("组1", GroupKind::Image).unwrap().id.clone();
        let _g2 = ws.create_group("组2", GroupKind::Image).unwrap().id.clone();
        let r1 = ws.create_round(&g1, "轮1").unwrap().id.clone();
        let r2 = ws.create_round(&g1, "轮2").unwrap().id.clone();
        ws.activate_round(&g1, &r1).unwrap();
        assert_eq!(ws.groups[0].active_round_id.as_deref(), Some(r1.as_str()));
        ws.activate_group(&g1).unwrap();
        assert_eq!(ws.active_group_id.as_deref(), Some(g1.as_str()));
        // 激活不存在的轮/组报错
        assert!(matches!(
            ws.activate_round(&g1, "不存在"),
            Err(WorkspaceError::RoundNotFound(_))
        ));
        assert!(matches!(
            ws.activate_group("不存在"),
            Err(WorkspaceError::GroupNotFound(_))
        ));
        assert!(matches!(
            ws.activate_round(&r2, &r2), // 组 ID 传成轮 ID
            Err(WorkspaceError::GroupNotFound(_))
        ));
    }

    #[test]
    fn json_roundtrip_preserves_everything() {
        let mut ws = Workspace::new();
        let g1 = ws.create_group("人像测试", GroupKind::Image).unwrap().id.clone();
        let g2 = ws.create_group("风景测试", GroupKind::Image).unwrap().id.clone();
        let r1 = ws.create_round(&g1, "轮1").unwrap().id.clone();
        ws.create_round(&g1, "轮2").unwrap();
        ws.activate_group(&g2).unwrap();
        ws.activate_round(&g1, &r1).unwrap();

        let restored = Workspace::from_json(&ws.to_json()).unwrap();
        assert_eq!(restored.format_version, FORMAT_VERSION);
        assert_eq!(restored.groups.len(), 2);
        assert_eq!(restored.groups[0].id, g1);
        assert_eq!(restored.groups[0].name, "人像测试");
        assert_eq!(restored.groups[0].rounds.len(), 2);
        assert_eq!(restored.groups[0].rounds[0].id, r1);
        assert_eq!(restored.groups[0].rounds[0].name, "轮1");
        assert_eq!(restored.groups[0].active_round_id.as_deref(), Some(r1.as_str()));
        assert_eq!(restored.groups[1].name, "风景测试");
        assert_eq!(restored.active_group_id.as_deref(), Some(g2.as_str()));
    }

    #[test]
    fn from_json_rejects_bad_json_and_wrong_version() {
        assert!(Workspace::from_json("不是 JSON").is_err());
        let future = r#"{"formatVersion": 999, "groups": []}"#;
        assert!(matches!(
            Workspace::from_json(future),
            Err(WorkspaceError::UnsupportedVersion(999, _))
        ));
    }

    #[test]
    fn from_json_tolerates_missing_optional_fields() {
        // 旧文件可能缺激活态字段；缺了就回落到 None，不报错
        let minimal = r#"{
            "formatVersion": 1,
            "groups": [{"id": "g-1", "name": "组", "rounds": [{"id": "r-1", "name": "轮"}]}]
        }"#;
        let ws = Workspace::from_json(minimal).unwrap();
        assert_eq!(ws.active_group_id, None);
        assert_eq!(ws.groups[0].active_round_id, None);
    }

    // ---------- T06：评测轮内容（原图 / 跑分图 / 指标结果） ----------

    #[test]
    fn new_round_has_no_reference_and_no_candidates() {
        let mut ws = Workspace::new();
        let g = ws.create_group("人像测试", GroupKind::Image).unwrap().id.clone();
        let r = ws.create_round(&g, "评测轮 1").unwrap().id.clone();
        let round = &ws.groups[0].rounds[0];
        assert_eq!(round.id, r);
        assert_eq!(round.reference_path, None);
        assert!(round.candidates.is_empty());
    }

    #[test]
    fn t05_json_without_round_content_still_loads() {
        // T05 时期的 workspace.json：评测轮只有 id/name，加载后内容字段为空
        let old = r#"{
            "formatVersion": 1,
            "groups": [{"id": "g-1", "name": "组", "rounds": [{"id": "r-1", "name": "轮"}]}]
        }"#;
        let ws = Workspace::from_json(old).unwrap();
        let round = &ws.groups[0].rounds[0];
        assert_eq!(round.reference_path, None);
        assert!(round.candidates.is_empty());
    }

    #[test]
    fn round_content_json_roundtrip() {
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Image).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        let round = &mut ws.groups[0].rounds[0];
        round.reference_path = Some("/tmp/photo-ref.png".to_string());
        round.candidates.push(CandidateImage {
            path: "/tmp/photo-dis.jpg".to_string(),
            file_size: 17341,
            size_ratio: Some(0.1364),
            metrics: Some(BTreeMap::from([
                ("PSNR".to_string(), MetricValue::Number(27.5)),
                ("SSIM".to_string(), MetricValue::Inf),
            ])),
            encoding_params: None,
            error: None,
        });
        let restored = Workspace::from_json(&ws.to_json()).unwrap();
        let round = &restored.groups[0].rounds[0];
        assert_eq!(round.reference_path.as_deref(), Some("/tmp/photo-ref.png"));
        assert_eq!(round.candidates.len(), 1);
        let candidate = &round.candidates[0];
        assert_eq!(candidate.path, "/tmp/photo-dis.jpg");
        assert_eq!(candidate.file_size, 17341);
        assert_eq!(candidate.size_ratio, Some(0.1364));
        let metrics = candidate.metrics.as_ref().unwrap();
        assert_eq!(metrics["PSNR"], MetricValue::Number(27.5));
        // 无穷大指标经 JSON 持久化后仍是无穷大（serde_json 把非有限浮点写成 null，读不回来）
        assert_eq!(metrics["SSIM"], MetricValue::Inf);
        assert_eq!(metrics["SSIM"].value(), f64::INFINITY);
        assert_eq!(candidate.error, None);
    }

    #[test]
    fn metric_value_rejects_garbage_string() {
        // 指标值里的字符串只接受 "inf" 哨兵，其他字符串是坏数据，拒绝加载
        let bad = r#"{"metrics": {"PSNR": "不是数字"}}"#;
        assert!(serde_json::from_str::<CandidateImage>(bad).is_err());
    }

    #[test]
    fn metric_value_new_maps_infinity_to_inf_sentinel() {
        assert_eq!(MetricValue::new(f64::INFINITY), MetricValue::Inf);
        assert_eq!(MetricValue::new(0.5), MetricValue::Number(0.5));
    }

    // ---------- T06：选图与跑分（公共 API 缝，用黄金基准样例图） ----------

    fn data(name: &str) -> String {
        format!("{}/tests/data/{name}", env!("CARGO_MANIFEST_DIR"))
    }

    #[test]
    fn set_round_reference_stores_path_and_computes_ratios() {
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Image).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        // 先选跑分图（还没有原图，体积比未知），再补选原图 → 比重算出来
        ws.add_round_candidates(&g, &r, &[&data("photo-dis.jpg")])
            .unwrap();
        assert_eq!(ws.groups[0].rounds[0].candidates[0].size_ratio, None);

        ws.set_round_reference(&g, &r, &data("photo-ref.png")).unwrap();
        let round = &ws.groups[0].rounds[0];
        assert_eq!(
            round.reference_path.as_deref(),
            Some(data("photo-ref.png").as_str())
        );
        // photo-dis.jpg 17341 字节 / photo-ref.png 127123 字节 ≈ 0.1364
        let ratio = round.candidates[0].size_ratio.expect("选完原图应有体积比");
        assert!((ratio - 17341.0 / 127123.0).abs() < 1e-12);
        // 不存在的原图路径 fail-fast
        assert!(ws
            .set_round_reference(&g, &r, "/不存在/的/图.png")
            .is_err());
    }

    #[test]
    fn add_candidates_reads_file_sizes_and_dedupes() {
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Image).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        ws.add_round_candidates(&g, &r, &[&data("photo-dis.jpg"), &data("photo-dis.webp")])
            .unwrap();
        let candidates = &ws.groups[0].rounds[0].candidates;
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].path, data("photo-dis.jpg"));
        assert_eq!(candidates[0].file_size, 17341);
        assert_eq!(candidates[1].file_size, 14532);
        // 同一批内与跨批次的重复路径都跳过
        ws.add_round_candidates(&g, &r, &[&data("photo-dis.jpg"), &data("photo-dis.jpg")])
            .unwrap();
        assert_eq!(ws.groups[0].rounds[0].candidates.len(), 2);
        // 不存在的文件 fail-fast，不落半批
        assert!(ws.add_round_candidates(&g, &r, &["/不存在.png"]).is_err());
        assert_eq!(ws.groups[0].rounds[0].candidates.len(), 2);
    }

    #[test]
    fn add_candidates_with_params_stores_encoding_params() {
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Image).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        // 一站式路径：参数与路径一一对应写入；外部导入路径（add_round_candidates）留空
        let params = vec![Some("JPEG q75".to_string()), None];
        ws.add_round_candidates_with_params(
            &g,
            &r,
            &[&data("photo-dis.jpg"), &data("photo-dis.webp")],
            Some(&params),
        )
        .unwrap();
        let candidates = &ws.groups[0].rounds[0].candidates;
        assert_eq!(candidates[0].encoding_params.as_deref(), Some("JPEG q75"));
        assert_eq!(candidates[1].encoding_params, None);

        // 编码参数随 JSON 持久化（camelCase encodingParams），旧文件缺字段回落 None
        let restored = Workspace::from_json(&ws.to_json()).unwrap();
        let restored_candidate = &restored.groups[0].rounds[0].candidates[0];
        assert_eq!(
            restored_candidate.encoding_params.as_deref(),
            Some("JPEG q75")
        );
        let json = ws.to_json();
        assert!(json.contains("\"encodingParams\": \"JPEG q75\""), "JSON 键名: {json}");

        // 重复触发（同路径已在列表里）幂等：保留行内原有参数，不产生重复行
        let again = vec![Some("另外的参数".to_string())];
        ws.add_round_candidates_with_params(&g, &r, &[&data("photo-dis.jpg")], Some(&again))
            .unwrap();
        let candidates = &ws.groups[0].rounds[0].candidates;
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].encoding_params.as_deref(), Some("JPEG q75"));
    }

    #[test]
    fn reselecting_reference_invalidates_old_results() {
        // 换原图后旧指标都是相对旧原图算的，作废；体积比不依赖画质，按新原图重算
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Image).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        ws.set_round_reference(&g, &r, &data("photo-ref.png")).unwrap();
        ws.add_round_candidates(&g, &r, &[&data("photo-dis.jpg")]).unwrap();
        ws.score_round_candidate(&g, &r, &data("photo-dis.jpg")).unwrap();
        assert!(ws.groups[0].rounds[0].candidates[0].metrics.is_some());

        ws.set_round_reference(&g, &r, &data("gradient-ref.png")).unwrap();
        let candidate = &ws.groups[0].rounds[0].candidates[0];
        assert_eq!(candidate.metrics, None);
        assert_eq!(candidate.error, None);
        // photo-dis.jpg 17341 字节 / gradient-ref.png 332 字节
        let ratio = candidate.size_ratio.expect("体积比应按新原图重算");
        assert!((ratio - 17341.0 / 332.0).abs() < 1e-12);
    }

    #[test]
    fn score_round_candidate_stores_metrics_for_each_row() {
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Image).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        ws.set_round_reference(&g, &r, &data("photo-ref.png")).unwrap();
        ws.add_round_candidates(
            &g,
            &r,
            &[&data("photo-dis.png"), &data("photo-dis.webp"), &data("photo-ref.png")],
        )
        .unwrap();

        ws.score_round_candidate(&g, &r, &data("photo-dis.png")).unwrap();
        // 只有被跑分的那张有结果，另一张仍是未跑分
        let candidates = &ws.groups[0].rounds[0].candidates;
        let metrics = candidates[0].metrics.as_ref().expect("跑分后应有指标");
        assert_eq!(candidates[0].error, None);
        // T04 五指标全部入库（BTreeMap 按字典序），结果表与导出报告的数据列由此驱动
        assert_eq!(
            metrics.keys().collect::<Vec<_>>(),
            vec!["Butteraugli", "MS-SSIM", "PSNR", "SSIM", "SSIMULACRA2"]
        );
        // 独立锚点：T02 交叉验证记录的自然图像中段 SSIM ≈ 0.52（photo-ref vs photo-dis.png）
        let ssim = metrics["SSIM"].value();
        assert!((0.4..=0.65).contains(&ssim), "SSIM 应在中段，实际 {ssim}");
        assert!(
            (0.0..=1.0).contains(&metrics["MS-SSIM"].value()),
            "MS-SSIM 应在 [0, 1]"
        );
        assert!(
            metrics["Butteraugli"].value() > 0.0 && metrics["SSIMULACRA2"].value() > 0.0,
            "感知指标应为有限正值"
        );
        assert!(candidates[1].metrics.is_none());

        // 逐像素相同的图 → PSNR 无穷大走 "inf" 哨兵；SSIM/MS-SSIM = 1，
        // Butteraugli = 0（距离分），SSIMULACRA2 = 100（质量分）
        ws.score_round_candidate(&g, &r, &data("photo-ref.png")).unwrap();
        assert!(ws.groups[0].rounds[0].candidates.contains(&CandidateImage {
            path: data("photo-ref.png"),
            file_size: 127123,
            size_ratio: Some(1.0),
            metrics: Some(BTreeMap::from([
                ("PSNR".to_string(), MetricValue::Inf),
                ("SSIM".to_string(), MetricValue::Number(1.0)),
                ("MS-SSIM".to_string(), MetricValue::Number(1.0)),
                ("Butteraugli".to_string(), MetricValue::Number(0.0)),
                ("SSIMULACRA2".to_string(), MetricValue::Number(100.0)),
            ])),
            error: None,
            encoding_params: None,
        }));
    }

    #[test]
    fn score_round_candidate_failure_marks_row_and_keeps_going() {
        // 尺寸不一致（128px vs 256px）：命令不报错，失败原因写进行里
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Image).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        ws.set_round_reference(&g, &r, &data("gradient-ref.png")).unwrap();
        ws.add_round_candidates(&g, &r, &[&data("photo-dis.jpg")]).unwrap();

        ws.score_round_candidate(&g, &r, &data("photo-dis.jpg")).unwrap();
        let candidate = &ws.groups[0].rounds[0].candidates[0];
        assert_eq!(candidate.metrics, None);
        let error = candidate.error.as_deref().expect("失败行应有原因");
        assert!(error.contains("尺寸"), "原因应可定位: {error}");
    }

    #[test]
    fn score_round_candidate_reports_missing_prerequisites() {
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Image).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        // 没选原图不能跑分
        assert!(matches!(
            ws.score_round_candidate(&g, &r, &data("photo-dis.jpg")),
            Err(WorkspaceError::ReferenceNotSet)
        ));
        ws.set_round_reference(&g, &r, &data("photo-ref.png")).unwrap();
        // 跑分图不在列表里
        assert!(matches!(
            ws.score_round_candidate(&g, &r, &data("photo-dis.jpg")),
            Err(WorkspaceError::CandidateNotFound(_))
        ));
        // 组/轮不存在
        ws.add_round_candidates(&g, &r, &[&data("photo-dis.jpg")]).unwrap();
        assert!(matches!(
            ws.score_round_candidate("不存在", &r, &data("photo-dis.jpg")),
            Err(WorkspaceError::GroupNotFound(_))
        ));
        assert!(matches!(
            ws.score_round_candidate(&g, "不存在", &data("photo-dis.jpg")),
            Err(WorkspaceError::RoundNotFound(_))
        ));
    }

    #[test]
    fn file_roundtrip_preserves_workspace() {
        let mut ws = Workspace::new();
        let g = ws.create_group("人像测试", GroupKind::Image).unwrap().id.clone();
        ws.create_round(&g, "轮1").unwrap();

        let mut path = std::env::temp_dir();
        path.push(format!("pixel-arena-test-{}.json", std::process::id()));
        let result = Workspace::load_from_file(&path);
        assert!(result.is_err()); // 文件不存在要报错，不能静默给空工作区
        ws.save_to_file(&path).unwrap();
        let restored = Workspace::load_from_file(&path).unwrap();
        assert_eq!(restored.groups[0].name, "人像测试");
        assert_eq!(restored.groups[0].rounds.len(), 1);
        assert_eq!(restored.active_group_id.as_deref(), Some(g.as_str()));
        std::fs::remove_file(&path).ok();
    }

    // ---------- T14：视频评测轮（原视频 / 跑分视频 / VMAF-PSNR-SSIM） ----------

    fn video_data(name: &str) -> String {
        format!("{}/tests/data/video/{name}", env!("CARGO_MANIFEST_DIR"))
    }

    /// 找一个带 libvmaf 滤镜的 ffmpeg（与 tests/video_scoring.rs 同规则；没有则跳过相关断言）。
    fn ffmpeg_with_libvmaf() -> Option<std::path::PathBuf> {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(env_path) = std::env::var("PIXEL_ARENA_FFMPEG") {
            candidates.push(std::path::PathBuf::from(env_path));
        }
        let data_home = std::env::var("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                std::env::var("HOME")
                    .map(|h| std::path::PathBuf::from(h).join(".local/share"))
                    .unwrap_or_default()
            });
        candidates.push(data_home.join("io.github.boxmiao007.pixelarena/tools/ffmpeg"));
        candidates.push(std::path::PathBuf::from("ffmpeg"));
        for candidate in candidates {
            let has_vmaf = std::process::Command::new(&candidate)
                .args(["-hide_banner", "-filters"])
                .output()
                .map(|out| String::from_utf8_lossy(&out.stdout).contains("libvmaf"))
                .unwrap_or(false);
            if has_vmaf {
                return Some(candidate);
            }
        }
        None
    }

    #[test]
    fn old_json_without_video_fields_loads_with_empty_video_section() {
        // T06 时期的评测轮 JSON：没有 videoReferencePath / videoCandidates 字段，加载后为空
        let old = r#"{
            "formatVersion": 1,
            "groups": [{"id": "g-1", "name": "组", "rounds": [{"id": "r-1", "name": "轮"}]}]
        }"#;
        let ws = Workspace::from_json(old).unwrap();
        let round = &ws.groups[0].rounds[0];
        assert_eq!(round.video_reference_path, None);
        assert!(round.video_candidates.is_empty());
    }

    #[test]
    fn video_candidates_json_roundtrip_preserves_elapsed_and_metrics() {
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Video).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        ws.groups[0].rounds[0].video_reference_path = Some("/tmp/ref.mp4".to_string());
        ws.groups[0].rounds[0].video_candidates.push(CandidateVideo {
            path: "/tmp/dis.mp4".to_string(),
            file_size: 27050,
            size_ratio: Some(0.4531),
            metrics: Some(BTreeMap::from([
                ("VMAF".to_string(), MetricValue::Number(94.87)),
                ("PSNR".to_string(), MetricValue::Inf),
                ("SSIM".to_string(), MetricValue::Number(0.9926)),
            ])),
            encoding_params: None,
            error: None,
            elapsed_ms: Some(1234),
        });
        let restored = Workspace::from_json(&ws.to_json()).unwrap();
        let round = &restored.groups[0].rounds[0];
        assert_eq!(round.video_reference_path.as_deref(), Some("/tmp/ref.mp4"));
        let candidate = &round.video_candidates[0];
        assert_eq!(candidate.file_size, 27050);
        assert_eq!(candidate.elapsed_ms, Some(1234));
        let metrics = candidate.metrics.as_ref().unwrap();
        assert_eq!(metrics["VMAF"], MetricValue::Number(94.87));
        assert_eq!(metrics["PSNR"], MetricValue::Inf);
        assert_eq!(metrics["SSIM"], MetricValue::Number(0.9926));
    }

    #[test]
    fn set_round_video_reference_stores_path_and_computes_ratios() {
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Video).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        // 先选跑分视频（还没有原视频，体积比未知），再补选原视频 → 比重算出来
        ws.add_round_video_candidates(&g, &r, &[&video_data("video-dis-150k.mp4")])
            .unwrap();
        assert_eq!(ws.groups[0].rounds[0].video_candidates[0].size_ratio, None);

        ws.set_round_video_reference(&g, &r, &video_data("video-ref-500k.mp4"))
            .unwrap();
        let round = &ws.groups[0].rounds[0];
        assert_eq!(
            round.video_reference_path.as_deref(),
            Some(video_data("video-ref-500k.mp4").as_str())
        );
        // video-dis-150k.mp4 27050 字节 / video-ref-500k.mp4 59771 字节
        let ratio = round.video_candidates[0].size_ratio.expect("选完原视频应有体积比");
        assert!((ratio - 27050.0 / 59771.0).abs() < 1e-12);
        // 不存在的原视频路径 fail-fast
        assert!(ws
            .set_round_video_reference(&g, &r, "/不存在/的/视频.mp4")
            .is_err());
    }

    #[test]
    fn add_round_video_candidates_dedupes_and_fails_fast() {
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Video).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        ws.add_round_video_candidates(
            &g,
            &r,
            &[&video_data("video-dis-150k.mp4"), &video_data("video-small-160x120.mp4")],
        )
        .unwrap();
        let candidates = &ws.groups[0].rounds[0].video_candidates;
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].file_size, 27050);
        // 同一批内与跨批次的重复路径都跳过
        ws.add_round_video_candidates(
            &g,
            &r,
            &[&video_data("video-dis-150k.mp4"), &video_data("video-dis-150k.mp4")],
        )
        .unwrap();
        assert_eq!(ws.groups[0].rounds[0].video_candidates.len(), 2);
        // 不存在的文件 fail-fast，不落半批
        assert!(ws.add_round_video_candidates(&g, &r, &["/不存在.mp4"]).is_err());
        assert_eq!(ws.groups[0].rounds[0].video_candidates.len(), 2);
    }

    #[test]
    fn reselecting_video_reference_invalidates_old_results() {
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Video).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        ws.set_round_video_reference(&g, &r, &video_data("video-ref-500k.mp4"))
            .unwrap();
        ws.add_round_video_candidates(&g, &r, &[&video_data("video-dis-150k.mp4")])
            .unwrap();
        if let Some(ffmpeg) = ffmpeg_with_libvmaf() {
            ws.score_round_video_candidate(
                &g,
                &r,
                &video_data("video-dis-150k.mp4"),
                &ffmpeg,
            )
            .unwrap();
            assert!(ws.groups[0].rounds[0].video_candidates[0].metrics.is_some());
        }

        ws.set_round_video_reference(&g, &r, &video_data("video-small-160x120.mp4"))
            .unwrap();
        let candidate = &ws.groups[0].rounds[0].video_candidates[0];
        assert_eq!(candidate.metrics, None);
        assert_eq!(candidate.error, None);
        assert_eq!(candidate.elapsed_ms, None);
        let ratio = candidate.size_ratio.expect("体积比应按新原视频重算");
        assert!((ratio - 27050.0 / 23032.0).abs() < 1e-12);
    }

    #[test]
    fn score_round_video_candidate_stores_metrics_and_elapsed() {
        let Some(ffmpeg) = ffmpeg_with_libvmaf() else {
            eprintln!("跳过：找不到带 libvmaf 滤镜的 ffmpeg（可设 PIXEL_ARENA_FFMPEG）");
            return;
        };
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Video).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        ws.set_round_video_reference(&g, &r, &video_data("video-ref-500k.mp4"))
            .unwrap();
        ws.add_round_video_candidates(
            &g,
            &r,
            &[&video_data("video-dis-150k.mp4"), &video_data("video-ref-500k.mp4")],
        )
        .unwrap();

        ws.score_round_video_candidate(&g, &r, &video_data("video-dis-150k.mp4"), &ffmpeg)
            .unwrap();
        let candidates = &ws.groups[0].rounds[0].video_candidates;
        let metrics = candidates[0].metrics.as_ref().expect("跑分后应有指标");
        // BTreeMap 按字典序迭代；前端结果表的列序在 video.ts 里按偏好重排（VMAF 优先展示）
        assert_eq!(metrics.keys().collect::<Vec<_>>(), vec!["PSNR", "SSIM", "VMAF"]);
        assert!(
            (30.0..=100.0).contains(&metrics["VMAF"].value()),
            "VMAF 应在合理区间，实际 {}",
            metrics["VMAF"].value()
        );
        assert!(candidates[0].error.is_none());
        assert!(candidates[0].elapsed_ms.unwrap() > 0, "应记录耗时");

        // 自身对比：PSNR 无穷大走 "inf" 哨兵
        ws.score_round_video_candidate(&g, &r, &video_data("video-ref-500k.mp4"), &ffmpeg)
            .unwrap();
        let metrics = &ws.groups[0].rounds[0].video_candidates[1]
            .metrics
            .as_ref()
            .expect("跑分后应有指标");
        assert_eq!(metrics["PSNR"], MetricValue::Inf);
    }

    #[test]
    fn score_round_video_candidate_failure_marks_row_and_records_elapsed() {
        let Some(ffmpeg) = ffmpeg_with_libvmaf() else {
            eprintln!("跳过：找不到带 libvmaf 滤镜的 ffmpeg（可设 PIXEL_ARENA_FFMPEG）");
            return;
        };
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Video).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        ws.set_round_video_reference(&g, &r, &video_data("video-ref-500k.mp4"))
            .unwrap();
        // 分辨率不一致：命令不报错，失败原因写进行里
        ws.add_round_video_candidates(&g, &r, &[&video_data("video-small-160x120.mp4")])
            .unwrap();

        ws.score_round_video_candidate(
            &g,
            &r,
            &video_data("video-small-160x120.mp4"),
            &ffmpeg,
        )
        .unwrap();
        let candidate = &ws.groups[0].rounds[0].video_candidates[0];
        assert_eq!(candidate.metrics, None);
        let error = candidate.error.as_deref().expect("失败行应有原因");
        assert!(error.contains("ffmpeg"), "原因应可定位: {error}");
        assert!(candidate.elapsed_ms.is_some(), "失败也应记录已耗时");
    }

    #[test]
    fn score_round_video_candidate_reports_missing_prerequisites() {
        let ffmpeg = std::path::PathBuf::from("ffmpeg"); // 前置检查先于 ffmpeg 启动，路径不会被用到
        let mut ws = Workspace::new();
        let g = ws.create_group("组", GroupKind::Video).unwrap().id.clone();
        let r = ws.create_round(&g, "轮").unwrap().id.clone();
        // 没选原视频不能跑分
        assert!(matches!(
            ws.score_round_video_candidate(&g, &r, &video_data("video-dis-150k.mp4"), &ffmpeg),
            Err(WorkspaceError::VideoReferenceNotSet)
        ));
        ws.set_round_video_reference(&g, &r, &video_data("video-ref-500k.mp4"))
            .unwrap();
        // 跑分视频不在列表里
        assert!(matches!(
            ws.score_round_video_candidate(&g, &r, &video_data("video-dis-150k.mp4"), &ffmpeg),
            Err(WorkspaceError::VideoCandidateNotFound(_))
        ));
        // 组/轮不存在
        ws.add_round_video_candidates(&g, &r, &[&video_data("video-dis-150k.mp4")])
            .unwrap();
        assert!(matches!(
            ws.score_round_video_candidate("不存在", &r, &video_data("video-dis-150k.mp4"), &ffmpeg),
            Err(WorkspaceError::GroupNotFound(_))
        ));
        assert!(matches!(
            ws.score_round_video_candidate(&g, "不存在", &video_data("video-dis-150k.mp4"), &ffmpeg),
            Err(WorkspaceError::RoundNotFound(_))
        ));
    }
}
