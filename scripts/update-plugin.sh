#!/bin/bash
#
# OpenClaw WeCom Plugin 本地更新脚本
# 使用 git clone/pull 从 GitHub 拉取源码并更新插件
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

# GitHub 仓库地址
GITHUB_REPO="https://github.com/tangqihy/openclaw-plugin-wecom.git"
GITHUB_BRANCH="main"

# 插件名称
PLUGIN_NAME="openclaw-plugin-wecom"

# 本地源码缓存目录
SOURCE_CACHE_DIR="$HOME/.openclaw/plugin-sources/$PLUGIN_NAME"

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

    # 检查 git 是否可用
    if ! command -v git &> /dev/null; then
        log_error "需要 git 来克隆/更新源码"
        exit 1
    fi

    # 1. 检测插件目录（支持通过环境变量指定）
    log_info "检测已安装的插件目录..."
    
    # 如果用户指定了 PLUGIN_DIR 环境变量，直接使用
    if [ -n "${PLUGIN_DIR:-}" ] && [ -d "$PLUGIN_DIR" ]; then
        log_info "使用指定的插件目录: $PLUGIN_DIR"
    else
        PLUGIN_DIR=$(detect_plugin_dir || echo "")
    fi
    
    if [ -z "$PLUGIN_DIR" ] || [ ! -d "$PLUGIN_DIR" ]; then
        log_error "未找到已安装的 $PLUGIN_NAME 插件"
        log_info ""
        log_info "解决方法："
        log_info "  1. 先安装插件: openclaw plugins install $PLUGIN_NAME"
        log_info "  2. 或手动指定目录: PLUGIN_DIR=/path/to/plugin $0"
        log_info ""
        log_info "常见插件位置："
        log_info "  - ~/.openclaw/plugins/node_modules/$PLUGIN_NAME"
        log_info "  - ~/.openclaw/node_modules/$PLUGIN_NAME"
        exit 1
    fi
    
    log_success "找到插件目录: $PLUGIN_DIR"

    # 2. 备份当前版本
    log_info "备份当前插件版本..."
    BACKUP_DIR="${PLUGIN_DIR}.backup.$(date +%Y%m%d_%H%M%S)"
    cp -r "$PLUGIN_DIR" "$BACKUP_DIR"
    log_success "备份完成: $BACKUP_DIR"

    # 3. 获取/更新源码
    log_info "获取最新源码..."
    
    mkdir -p "$(dirname "$SOURCE_CACHE_DIR")"
    
    if [ -d "$SOURCE_CACHE_DIR/.git" ]; then
        # 已有本地仓库，执行 pull
        log_info "更新本地源码缓存..."
        cd "$SOURCE_CACHE_DIR"
        git fetch origin "$GITHUB_BRANCH"
        git reset --hard "origin/$GITHUB_BRANCH"
        git clean -fd
    else
        # 没有本地仓库，执行 clone
        log_info "克隆源码仓库..."
        rm -rf "$SOURCE_CACHE_DIR"
        git clone --depth 1 --branch "$GITHUB_BRANCH" "$GITHUB_REPO" "$SOURCE_CACHE_DIR"
        cd "$SOURCE_CACHE_DIR"
    fi
    
    # 获取版本信息
    COMMIT_HASH=$(git rev-parse --short HEAD)
    log_success "源码获取完成 (commit: $COMMIT_HASH)"

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
        "image-processor.js"
        "logger.js"
        "utils.js"
        "package.json"
        "openclaw.plugin.json"
    )
    
    for file in "${FILES_TO_UPDATE[@]}"; do
        if [ -f "$SOURCE_CACHE_DIR/$file" ]; then
            cp "$SOURCE_CACHE_DIR/$file" "$PLUGIN_DIR/$file"
            log_info "  更新: $file"
        fi
    done
    
    log_success "插件文件更新完成"

    # 5. 显示版本信息
    if [ -f "$PLUGIN_DIR/package.json" ]; then
        NEW_VERSION=$(grep -o '"version": "[^"]*"' "$PLUGIN_DIR/package.json" | cut -d'"' -f4)
        log_success "插件已更新到版本: $NEW_VERSION (commit: $COMMIT_HASH)"
    fi

    # 6. 重启 OpenClaw Gateway
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
    echo "源码缓存位置: $SOURCE_CACHE_DIR"
    echo ""
    echo "如需回滚，请执行:"
    echo "    rm -rf $PLUGIN_DIR"
    echo "    mv $BACKUP_DIR $PLUGIN_DIR"
    echo "    openclaw gateway restart"
    echo ""
}

# 执行主流程
main "$@"
