# 捆绑编码器准备（T29-4，决策 0014 修订）：Windows x86_64 版——下载锁定工件 →
# sha256 校验 → 解出成员可执行文件到 src-tauri/resources/encoders/，供 tauri
# 打包捆绑进安装包。Linux/macOS 走 bundle-encoders.sh。
#
# URL 与 sha256 必须与 crates/pixel-arena-core/src/encode.rs 的来源清单同步修改
# （升级版本 = 两边一起改）。仓库 assets/encoders/ 有同名工件时直接复用。

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$dest = Join-Path $repoRoot "src-tauri\resources\encoders"
$work = Join-Path ([System.IO.Path]::GetTempPath()) ("pa-encoders-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $dest, $work | Out-Null

# fetch <url> <sha256> <输出文件名>：仓库 assets/encoders/ 缓存优先
function Fetch([string]$url, [string]$sha256, [string]$out) {
    $target = Join-Path $work $out
    $cached = Join-Path $repoRoot "assets\encoders\$out"
    if (Test-Path $cached) {
        Write-Host "使用本地工件 $cached"
        Copy-Item $cached $target
    } else {
        Write-Host "下载 $url"
        curl.exe -fL --retry 3 --retry-delay 2 -o $target $url
        if ($LASTEXITCODE -ne 0) { throw "下载失败: $url" }
    }
    $actual = (Get-FileHash -Algorithm SHA256 $target).Hash.ToLower()
    if ($actual -ne $sha256) { throw "sha256 校验失败: $out（期望 $sha256，实际 $actual）" }
}

# extract <工件路径> <成员名>…：解包后按文件名递归查找成员（容忍包内多一层目录，
# 与核心库 extract_archive_members 同一口径）
function Extract([string]$archive, [string[]]$members) {
    $stage = Join-Path $work "stage"
    if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Expand-Archive -Path $archive -DestinationPath $stage
    foreach ($member in $members) {
        $found = Get-ChildItem -Path $stage -Recurse -Filter $member -File | Select-Object -First 1
        if ($null -eq $found) { throw "工件内未找到成员 $member（$archive）" }
        Copy-Item $found.FullName (Join-Path $dest $member) -Force
        Write-Host "捆绑成员 $member（来自 $(Split-Path $archive -Leaf)）"
    }
}

Fetch "https://github.com/BoxMiao007/pixel-arena/releases/download/encoders-v1/mozjpeg-v4.1.5-windows-x86_64.tar.gz" `
    "ded15725f25ff321de1cf56b5faa6a0bd6389111ed3a56faf72016aaa5b6713b" "mozjpeg-v4.1.5-windows-x86_64.tar.gz"
# MozJPEG 工件是 tar.gz：Windows 10+ 自带 bsdtar 可解
tar -xzf (Join-Path $work "mozjpeg-v4.1.5-windows-x86_64.tar.gz") -C $work
$cjpeg = Get-ChildItem -Path $work -Recurse -Filter "cjpeg.exe" -File |
    Where-Object { $_.DirectoryName -notlike "$dest*" } | Select-Object -First 1
if ($null -eq $cjpeg) { throw "MozJPEG 工件内未找到 cjpeg.exe" }
Copy-Item $cjpeg.FullName (Join-Path $dest "cjpeg.exe") -Force

Fetch "https://storage.googleapis.com/downloads.webmproject.org/releases/webp/libwebp-1.6.0-windows-x64.zip" `
    "48886f506b21f62e4661f0f4cbfca19800897c385128e8902542d29a950c93f1" "libwebp-1.6.0-windows-x64.zip"
Extract (Join-Path $work "libwebp-1.6.0-windows-x64.zip") @("cwebp.exe")

Fetch "https://github.com/AOMediaCodec/libavif/releases/download/v1.4.2/windows-artifacts.zip" `
    "cb2d9fea43dcbab1d0707e3b37eb7b08070ad2fb60a2c188c39ec12382c0484a" "libavif-windows-artifacts.zip"
Extract (Join-Path $work "libavif-windows-artifacts.zip") @("avifenc.exe", "avifdec.exe")

Fetch "https://github.com/libjxl/libjxl/releases/download/v0.11.1/jxl-x64-windows-static.zip" `
    "8f53ebce91820c30c9fc9294f06380213c1e2e66b361718880580246b2be008e" "jxl-x64-windows-static.zip"
Extract (Join-Path $work "jxl-x64-windows-static.zip") @("cjxl.exe")

Remove-Item -Recurse -Force $work
Write-Host "---- 捆绑目录内容 ----"
Get-ChildItem $dest | Format-Table Name, Length
