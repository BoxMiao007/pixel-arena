// 跑分组数据模型与 JSON 持久化（T05）。
// 术语以 GLOSSARY.md 为准：跑分组 = Group（一个标签页），评测轮 = Round（组内一次评测）。
// 工作区（Workspace）= 应用保存的全部跑分组状态，序列化为单个 JSON 文件。
//
// 演进约定：JSON 顶层带 format_version；后续给评测轮补「原图/跑分图/结果」等字段时，
// 新字段一律加 #[serde(default)]，保证旧文件仍能加载；本文件不预写用不到的字段。

use serde::{Deserialize, Serialize};
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

/// 跑分组：一个标签页承载的独立评测工作单元。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub rounds: Vec<Round>,
    /// 组内当前激活的评测轮；组存在但还没有轮次时为 None。
    #[serde(default)]
    pub active_round_id: Option<String>,
}

/// 评测轮：跑分组内的一次评测。T05 只建模名称，原图/跑分图/结果由 T06 起补字段。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Round {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("跑分组不存在: {0}")]
    GroupNotFound(String),
    #[error("评测轮不存在: {0}")]
    RoundNotFound(String),
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
    pub fn create_group(&mut self, name: &str) -> Result<&Group, WorkspaceError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(WorkspaceError::BlankName);
        }
        let group = Group {
            id: new_id("g"),
            name: name.to_string(),
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
    pub fn from_json(json: &str) -> Result<Self, WorkspaceError> {
        let ws: Workspace = serde_json::from_str(json)?;
        if ws.format_version != FORMAT_VERSION {
            return Err(WorkspaceError::UnsupportedVersion(
                ws.format_version,
                FORMAT_VERSION,
            ));
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
        ws.create_group("人像测试").unwrap();
        assert_eq!(ws.groups.len(), 1);
        assert_eq!(ws.groups[0].name, "人像测试");
        assert!(!ws.groups[0].id.is_empty());
        assert_eq!(ws.active_group_id.as_deref(), Some(ws.groups[0].id.as_str()));
    }

    #[test]
    fn create_group_rejects_blank_name() {
        let mut ws = Workspace::new();
        assert!(ws.create_group("   ").is_err());
        assert!(ws.groups.is_empty());
    }

    #[test]
    fn rename_group_updates_name() {
        let mut ws = Workspace::new();
        let g = ws.create_group("旧名").unwrap().id.clone();
        ws.rename_group(&g, "人像测试").unwrap();
        assert_eq!(ws.groups[0].name, "人像测试");
    }

    #[test]
    fn rename_group_rejects_blank_and_missing() {
        let mut ws = Workspace::new();
        let g = ws.create_group("甲").unwrap().id.clone();
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
        let a = ws.create_group("甲").unwrap().id.clone();
        let b = ws.create_group("乙").unwrap().id.clone();
        let c = ws.create_group("丙").unwrap().id.clone();
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
        let a = ws.create_group("甲").unwrap().id.clone();
        let b = ws.create_group("乙").unwrap().id.clone();
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
        let g = ws.create_group("人像测试").unwrap().id.clone();
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
        let g = ws.create_group("组").unwrap().id.clone();
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
        let g = ws.create_group("组").unwrap().id.clone();
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
        let g1 = ws.create_group("组1").unwrap().id.clone();
        let _g2 = ws.create_group("组2").unwrap().id.clone();
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
        let g1 = ws.create_group("人像测试").unwrap().id.clone();
        let g2 = ws.create_group("风景测试").unwrap().id.clone();
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

    #[test]
    fn file_roundtrip_preserves_workspace() {
        let mut ws = Workspace::new();
        let g = ws.create_group("人像测试").unwrap().id.clone();
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
}
