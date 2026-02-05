#!/bin/bash
#
# OpenClaw WeCom Plugin 本地更新脚本
# 用于从 GitHub fork 拉取最新代码并替换已安装的插件
#
# 使用方法:
#   curl -sSL https://raw.githubusercontent.com/tangqihy/openclaw-plugin-wecom/main/scripts/update-plugin.sh | bash
#   或者:
#   ./scripts/update-plugin.sh
#

set -e

# ============================================================================
# 配置
# ============================================================================

# GitHub 仓库地址 (修改为你自己的 fork)
GITHUB_REPO="tangqihy/openclaw-plugin-wecom"
GITHUB_BRANCH="main"

# 插件名称
PLUGIN_NAME="openclaw-plugin-wecom"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# ============================================================================
# 检测 OpenClaw 插件目录
# ============================================================================

detect_plugin_dir() {
    # 常见的插件安装位置
    local possible_dirs=(
        "$HOME/.openclaw/plugins/node_modules/$PLUGIN_NAME"
        "$HOME/.openclaw/node_modules/$PLUGIN_NAME"
        "/usr/local/lib/node_modules/$PLUGIN_NAME"
        "./node_modules/$PLUGIN_NAME"
    )

    for dir in "${possible_dirs[@]}"; do
        if [ -d "$dir" ]; then
            echo "$dir"
            return 0
        fi
    done

    # 尝试通过 npm 查找
    local npm_root=$(npm root -g 2>/dev/null || echo "")
    if [ -n "$npm_root" ] && [ -d "$npm_root/$PLUGIN_NAME" ]; then
        echo "$npm_root/$PLUGIN_NAME"
        return 0
    fi

    return 1
}

# ============================================================================
# 主流程
# ============================================================================

main() {
    echo ""
    echo "=========================================="
    echo "  OpenClaw WeCom Plugin 本地更新脚本"
    echo "=========================================="
    echo ""

    # 1. 检测插件目录
    log_info "检测已安装的插件目录..."
    
    PLUGIN_DIR=$(detect_plugin_dir)
    
    if [ -z "$PLUGIN_DIR" ]; then
        log_error "未找到已安装的 $PLUGIN_NAME 插件"
        log_info "请先使用 'openclaw plugins install $PLUGIN_NAME' 安装插件"
        exit 1
    fi
    
    log_success "找到插件目录: $PLUGIN_DIR"

    # 2. 备份当前版本
    log_info "备份当前插件版本..."
    BACKUP_DIR="${PLUGIN_DIR}.backup.$(date +%Y%m%d_%H%M%S)"
    cp -r "$PLUGIN_DIR" "$BACKUP_DIR"
    log_success "备份完成: $BACKUP_DIR"

    # 3. 下载最新代码
    log_info "从 GitHub 下载最新代码..."
    TEMP_DIR=$(mktemp -d)
    
    # 下载 zip 并解压
    DOWNLOAD_URL="https://github.com/$GITHUB_REPO/archive/refs/heads/$GITHUB_BRANCH.zip"
    
    if command -v curl &> /dev/null; then
        curl -sSL "$DOWNLOAD_URL" -o "$TEMP_DIR/plugin.zip"
    elif command -v wget &> /dev/null; then
        wget -q "$DOWNLOAD_URL" -O "$TEMP_DIR/plugin.zip"
    else
        log_error "需要 curl 或 wget 来下载文件"
        exit 1
    fi
    
    # 解压
    if command -v unzip &> /dev/null; then
        unzip -q "$TEMP_DIR/plugin.zip" -d "$TEMP_DIR"
    else
        log_error "需要 unzip 来解压文件"
        exit 1
    fi
    
    # 找到解压后的目录
    EXTRACTED_DIR=$(find "$TEMP_DIR" -maxdepth 1 -type d -name "openclaw-plugin-wecom-*" | head -1)
    
    if [ -z "$EXTRACTED_DIR" ]; then
        log_error "解压失败，未找到插件目录"
        exit 1
    fi
    
    log_success "下载完成"

    # 4. 更新插件文件
    log_info "更新插件文件..."
    
    # 需要更新的文件列表
    FILES_TO_UPDATE=(
        "index.js"
        "webhook.js"
        "stream-manager.js"
        "heartbeat-manager.js"
        "message-queue.js"
        "media-handler.js"
        "client.js"
        "crypto.js"
        "dynamic-agent.js"
        "logger.js"
        "utils.js"
        "package.json"
        "openclaw.plugin.json"
    )
    
    for file in "${FILES_TO_UPDATE[@]}"; do
        if [ -f "$EXTRACTED_DIR/$file" ]; then
            cp "$EXTRACTED_DIR/$file" "$PLUGIN_DIR/$file"
            log_info "  更新: $file"
        fi
    done
    
    # 复制可能存在的其他文件
    if [ -f "$EXTRACTED_DIR/image-processor.js" ]; then
        cp "$EXTRACTED_DIR/image-processor.js" "$PLUGIN_DIR/"
        log_info "  更新: image-processor.js"
    fi
    
    log_success "插件文件更新完成"

    # 5. 清理临时文件
    rm -rf "$TEMP_DIR"
    log_info "清理临时文件完成"

    # 6. 显示版本信息
    if [ -f "$PLUGIN_DIR/package.json" ]; then
        NEW_VERSION=$(grep -o '"version": "[^"]*"' "$PLUGIN_DIR/package.json" | cut -d'"' -f4)
        log_success "插件已更新到版本: $NEW_VERSION"
    fi

    # 7. 重启 OpenClaw Gateway
    echo ""
    log_info "重启 OpenClaw Gateway 以应用更改..."
    
    if command -v openclaw &> /dev/null; then
        openclaw gateway restart
        log_success "OpenClaw Gateway 已重启"
    else
        log_warn "未找到 openclaw 命令，请手动重启 Gateway:"
        echo "    openclaw gateway restart"
    fi

    echo ""
    echo "=========================================="
    log_success "插件更新完成！"
    echo "=========================================="
    echo ""
    echo "如需回滚，请执行:"
    echo "    rm -rf $PLUGIN_DIR"
    echo "    mv $BACKUP_DIR $PLUGIN_DIR"
    echo "    openclaw gateway restart"
    echo ""
}

# 执行主流程
main "$@"
