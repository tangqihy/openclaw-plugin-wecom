#
# OpenClaw WeCom Plugin 本地更新脚本 (Windows PowerShell)
# 使用 git clone/pull 从 GitHub 拉取源码并更新插件
#
# 使用方法:
#   irm https://raw.githubusercontent.com/tangqihy/openclaw-plugin-wecom/main/scripts/update-plugin.ps1 | iex
#   或者:
#   .\scripts\update-plugin.ps1
#

$ErrorActionPreference = "Stop"

# ============================================================================
# 配置
# ============================================================================

$GITHUB_REPO = "https://github.com/tangqihy/openclaw-plugin-wecom.git"
$GITHUB_BRANCH = "main"
$PLUGIN_NAME = "openclaw-plugin-wecom"
$SOURCE_CACHE_DIR = "$env:USERPROFILE\.openclaw\plugin-sources\$PLUGIN_NAME"

# ============================================================================
# 辅助函数
# ============================================================================

function Write-Info($msg) {
    Write-Host "[INFO] " -ForegroundColor Blue -NoNewline
    Write-Host $msg
}

function Write-Success($msg) {
    Write-Host "[SUCCESS] " -ForegroundColor Green -NoNewline
    Write-Host $msg
}

function Write-Warn($msg) {
    Write-Host "[WARN] " -ForegroundColor Yellow -NoNewline
    Write-Host $msg
}

function Write-Err($msg) {
    Write-Host "[ERROR] " -ForegroundColor Red -NoNewline
    Write-Host $msg
}

# ============================================================================
# 检测 OpenClaw 插件目录
# ============================================================================

function Find-PluginDir {
    $possibleDirs = @(
        "$env:USERPROFILE\.openclaw\plugins\node_modules\$PLUGIN_NAME",
        "$env:USERPROFILE\.openclaw\node_modules\$PLUGIN_NAME",
        "$env:APPDATA\npm\node_modules\$PLUGIN_NAME",
        ".\node_modules\$PLUGIN_NAME"
    )

    foreach ($dir in $possibleDirs) {
        if (Test-Path $dir) {
            return $dir
        }
    }

    # 尝试通过 npm 查找
    try {
        $npmRoot = npm root -g 2>$null
        if ($npmRoot -and (Test-Path "$npmRoot\$PLUGIN_NAME")) {
            return "$npmRoot\$PLUGIN_NAME"
        }
    } catch {}

    return $null
}

# ============================================================================
# 主流程
# ============================================================================

function Main {
    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host "  OpenClaw WeCom Plugin 本地更新脚本" -ForegroundColor Cyan
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host ""

    # 检查 git 是否可用
    try {
        $null = Get-Command git -ErrorAction Stop
    } catch {
        Write-Err "需要 git 来克隆/更新源码"
        Write-Info "请先安装 Git: https://git-scm.com/download/win"
        exit 1
    }

    # 1. 检测插件目录
    Write-Info "检测已安装的插件目录..."
    
    $pluginDir = Find-PluginDir
    
    if (-not $pluginDir) {
        Write-Err "未找到已安装的 $PLUGIN_NAME 插件"
        Write-Info "请先使用 'openclaw plugins install $PLUGIN_NAME' 安装插件"
        exit 1
    }
    
    Write-Success "找到插件目录: $pluginDir"

    # 2. 备份当前版本
    Write-Info "备份当前插件版本..."
    $timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
    $backupDir = "$pluginDir.backup.$timestamp"
    Copy-Item -Path $pluginDir -Destination $backupDir -Recurse
    Write-Success "备份完成: $backupDir"

    # 3. 获取/更新源码
    Write-Info "获取最新源码..."
    
    $sourceCacheParent = Split-Path $SOURCE_CACHE_DIR -Parent
    if (-not (Test-Path $sourceCacheParent)) {
        New-Item -ItemType Directory -Path $sourceCacheParent -Force | Out-Null
    }
    
    $commitHash = ""
    
    if (Test-Path "$SOURCE_CACHE_DIR\.git") {
        # 已有本地仓库，执行 pull
        Write-Info "更新本地源码缓存..."
        Push-Location $SOURCE_CACHE_DIR
        try {
            git fetch origin $GITHUB_BRANCH 2>&1 | Out-Null
            git reset --hard "origin/$GITHUB_BRANCH" 2>&1 | Out-Null
            git clean -fd 2>&1 | Out-Null
            $commitHash = git rev-parse --short HEAD
        } finally {
            Pop-Location
        }
    } else {
        # 没有本地仓库，执行 clone
        Write-Info "克隆源码仓库..."
        if (Test-Path $SOURCE_CACHE_DIR) {
            Remove-Item -Path $SOURCE_CACHE_DIR -Recurse -Force
        }
        git clone --depth 1 --branch $GITHUB_BRANCH $GITHUB_REPO $SOURCE_CACHE_DIR 2>&1 | Out-Null
        Push-Location $SOURCE_CACHE_DIR
        try {
            $commitHash = git rev-parse --short HEAD
        } finally {
            Pop-Location
        }
    }
    
    Write-Success "源码获取完成 (commit: $commitHash)"

    # 4. 更新插件文件
    Write-Info "更新插件文件..."
    
    $filesToUpdate = @(
        "index.js",
        "webhook.js",
        "stream-manager.js",
        "heartbeat-manager.js",
        "message-queue.js",
        "media-handler.js",
        "client.js",
        "crypto.js",
        "dynamic-agent.js",
        "image-processor.js",
        "logger.js",
        "utils.js",
        "package.json",
        "openclaw.plugin.json"
    )
    
    foreach ($file in $filesToUpdate) {
        $srcPath = Join-Path $SOURCE_CACHE_DIR $file
        $dstPath = Join-Path $pluginDir $file
        if (Test-Path $srcPath) {
            Copy-Item -Path $srcPath -Destination $dstPath -Force
            Write-Info "  更新: $file"
        }
    }
    
    Write-Success "插件文件更新完成"

    # 5. 显示版本信息
    $packageJson = Join-Path $pluginDir "package.json"
    if (Test-Path $packageJson) {
        $pkg = Get-Content $packageJson | ConvertFrom-Json
        Write-Success "插件已更新到版本: $($pkg.version) (commit: $commitHash)"
    }

    # 6. 重启 OpenClaw Gateway
    Write-Host ""
    Write-Info "重启 OpenClaw Gateway 以应用更改..."
    
    try {
        $openclawPath = Get-Command openclaw -ErrorAction SilentlyContinue
        if ($openclawPath) {
            openclaw gateway restart
            Write-Success "OpenClaw Gateway 已重启"
        } else {
            throw "未找到 openclaw 命令"
        }
    } catch {
        Write-Warn "未找到 openclaw 命令，请手动重启 Gateway:"
        Write-Host "    openclaw gateway restart"
    }

    Write-Host ""
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Success "插件更新完成！"
    Write-Host "==========================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "源码缓存位置: $SOURCE_CACHE_DIR"
    Write-Host ""
    Write-Host "如需回滚，请执行:"
    Write-Host "    Remove-Item -Path '$pluginDir' -Recurse -Force"
    Write-Host "    Rename-Item -Path '$backupDir' -NewName '$PLUGIN_NAME'"
    Write-Host "    openclaw gateway restart"
    Write-Host ""
}

# 执行主流程
Main
