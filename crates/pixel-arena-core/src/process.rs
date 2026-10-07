// 子进程派生的 Windows 终口窗口抑制（issue #42，v0.1.4 Windows 真机反馈）：
// Windows 上 std::process::Command 派生子进程默认会带出 conhost 终端窗口，
// GUI 里每次版本探测 / 编码 / 跑分都闪黑框。CREATE_NO_WINDOW（0x08000000）
// 让子进程不创建控制台窗口。集中成助手的理由：派生点分散在核心库与应用壳的
// 多个模块，逐点手写 cfg 代码容易漏；非 Windows 平台是无害 no-op，行为零变化。

/// Windows CREATE_NO_WINDOW 标志位（winbase.h：0x08000000，子进程不创建控制台窗口）。
/// 仅 [`apply_no_window`] 的 Windows 分支使用，不对外暴露。
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 给命令加 Windows「不弹终端窗口」处理（issue #42）。在 `Command::new` 之后、
/// `spawn` / `output` 之前调用；非 Windows 平台是无害 no-op。
pub fn apply_no_window(command: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_no_window_keeps_command_attributes_unchanged() {
        // 非 Windows 平台 helper 必须是纯 no-op：程序、参数、工作目录等关键属性
        // 一个都不能变（Windows 上 std 不提供 creation_flags 的读取器，该平台的
        // 正确性由 cfg 编译期保证：分支体只调用 creation_flags 追加标志位）。
        let mut command = std::process::Command::new("ffmpeg");
        command.arg("-version").current_dir("/");

        let program_before = command.get_program().to_owned();
        let args_before: Vec<_> = command.get_args().map(|a| a.to_owned()).collect();
        let dir_before = command.get_current_dir().map(|p| p.to_owned());

        apply_no_window(&mut command);

        assert_eq!(command.get_program(), program_before);
        let args_after: Vec<_> = command.get_args().map(|a| a.to_owned()).collect();
        assert_eq!(args_after, args_before);
        assert_eq!(command.get_current_dir(), dir_before.as_deref());
    }
}
