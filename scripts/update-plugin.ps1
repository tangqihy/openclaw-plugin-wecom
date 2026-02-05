#
# OpenClaw WeCom Plugin 本地更新脚本 (Windows PowerShell)
# 用于从 GitHub fork 拉取最新代码并替换已安装的插件
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

$GITHUB_REPO = "tangqihy/openclaw-plugin-wecom"
$GITHUB_BRANCH = "main"
$PLUGIN_NAME = "openclaw-plugin-wecom"

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

    # 3. 下载最新代码
    Write-Info "从 GitHub 下载最新代码..."
    $tempDir = New-TemporaryFile | ForEach-Object { Remove-Item $_; New-Item -ItemType Directory -Path $_ }
    $zipPath = Join-Path $tempDir "plugin.zip"
    
    $downloadUrl = "https://github.com/$GITHUB_REPO/archive/refs/heads/$GITHUB_BRANCH.zip"
    
    try {
        Invoke-WebRequest -Uri $downloadUrl -OutFile $zipPath -UseBasicParsing
    } catch {
        Write-Err "下载失败: $_"
        exit 1
    }
    
    # 解压
    $extractPath = Join-Path $tempDir "extracted"
    Expand-Archive -Path $zipPath -DestinationPath $extractPath
    
    # 找到解压后的目录
    $extractedDir = Get-ChildItem -Path $extractPath -Directory | Where-Object { $_.Name -like "openclaw-plugin-wecom-*" } | Select-Object -First 1
    
    if (-not $extractedDir) {
        Write-Err "解压失败，未找到插件目录"
        exit 1
    }
    
    Write-Success "下载完成"

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
        "logger.js",
        "utils.js",
        "package.json",
        "openclaw.plugin.json",
        "image-processor.js"
    )
    
    foreach ($file in $filesToUpdate) {
        $srcPath = Join-Path $extractedDir.FullName $file
        $dstPath = Join-Path $pluginDir $file
        if (Test-Path $srcPath) {
            Copy-Item -Path $srcPath -Destination $dstPath -Force
            Write-Info "  更新: $file"
        }
    }
    
    Write-Success "插件文件更新完成"

    # 5. 清理临时文件
    Remove-Item -Path $tempDir -Recurse -Force
    Write-Info "清理临时文件完成"

    # 6. 显示版本信息
    $packageJson = Join-Path $pluginDir "package.json"
    if (Test-Path $packageJson) {
        $pkg = Get-Content $packageJson | ConvertFrom-Json
        Write-Success "插件已更新到版本: $($pkg.version)"
    }

    # 7. 重启 OpenClaw Gateway
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
    Write-Host "如需回滚，请执行:"
    Write-Host "    Remove-Item -Path '$pluginDir' -Recurse -Force"
    Write-Host "    Rename-Item -Path '$backupDir' -NewName '$PLUGIN_NAME'"
    Write-Host "    openclaw gateway restart"
    Write-Host ""
}

# 执行主流程
Main
