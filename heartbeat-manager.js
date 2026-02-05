import { logger } from "./logger.js";
import { streamManager } from "./stream-manager.js";

/**
 * 心跳管理器
 * 在 AI 处理期间定时更新流内容，避免企业微信超时
 */
class HeartbeatManager {
    constructor() {
        // streamId -> { timer, startTime, dots, originalContent }
        this.heartbeats = new Map();
        
        // 心跳配置
        this.config = {
            interval: 3000,        // 心跳间隔 3 秒
            maxTimeout: 60000,     // 最大超时 60 秒
            thinkingMessages: [
                "正在思考",
                "正在分析",
                "正在处理",
                "正在生成回复",
            ],
        };
    }

    /**
     * 启动心跳
     * @param {string} streamId - 流 ID
     * @param {object} options - 可选配置
     * @param {function} options.onTimeout - 超时回调
     * @returns {function} 停止心跳的函数
     */
    start(streamId, options = {}) {
        if (this.heartbeats.has(streamId)) {
            logger.warn("Heartbeat already exists for stream", { streamId });
            return () => this.stop(streamId);
        }

        const state = {
            timer: null,
            startTime: Date.now(),
            dots: 0,
            messageIndex: 0,
            hasContent: false,
            onTimeout: options.onTimeout,
        };

        // 启动心跳定时器
        state.timer = setInterval(() => {
            this._tick(streamId, state);
        }, this.config.interval);

        this.heartbeats.set(streamId, state);
        logger.debug("Heartbeat started", { streamId });

        return () => this.stop(streamId);
    }

    /**
     * 心跳 tick
     */
    _tick(streamId, state) {
        const elapsed = Date.now() - state.startTime;
        
        // 检查是否超时
        if (elapsed >= this.config.maxTimeout) {
            logger.warn("Heartbeat timeout reached", { streamId, elapsed });
            this.stop(streamId);
            
            if (state.onTimeout) {
                state.onTimeout(streamId);
            }
            return;
        }

        // 获取当前流状态
        const stream = streamManager.getStream(streamId);
        if (!stream) {
            logger.debug("Stream not found, stopping heartbeat", { streamId });
            this.stop(streamId);
            return;
        }

        // 如果流已完成，停止心跳
        if (stream.finished) {
            logger.debug("Stream finished, stopping heartbeat", { streamId });
            this.stop(streamId);
            return;
        }

        // 如果流已有实际内容（非心跳内容），不再更新心跳
        if (stream.content && !this._isHeartbeatContent(stream.content)) {
            state.hasContent = true;
            return;
        }

        // 如果已经有实际内容，不覆盖
        if (state.hasContent) {
            return;
        }

        // 生成心跳消息
        state.dots = (state.dots + 1) % 4;
        const dots = ".".repeat(state.dots + 1);
        const msgIndex = Math.floor(elapsed / 10000) % this.config.thinkingMessages.length;
        const thinkingMsg = this.config.thinkingMessages[msgIndex];
        
        const heartbeatContent = `${thinkingMsg}${dots} ⏳`;
        
        // 使用 updateStream 而不是 appendStream，避免累积
        streamManager.updateStream(streamId, heartbeatContent, false);
        
        logger.debug("Heartbeat tick", { 
            streamId, 
            elapsed: Math.round(elapsed / 1000) + "s",
            content: heartbeatContent 
        });
    }

    /**
     * 检查内容是否是心跳内容
     */
    _isHeartbeatContent(content) {
        if (!content) return false;
        // 心跳内容特征：以思考消息开头，以 ⏳ 结尾
        return content.includes("⏳") && (
            content.includes("正在思考") ||
            content.includes("正在分析") ||
            content.includes("正在处理") ||
            content.includes("正在生成回复")
        );
    }

    /**
     * 停止心跳
     * @param {string} streamId - 流 ID
     */
    stop(streamId) {
        const state = this.heartbeats.get(streamId);
        if (!state) {
            return false;
        }

        if (state.timer) {
            clearInterval(state.timer);
        }

        this.heartbeats.delete(streamId);
        logger.debug("Heartbeat stopped", { streamId });
        return true;
    }

    /**
     * 检查是否有活跃心跳
     */
    has(streamId) {
        return this.heartbeats.has(streamId);
    }

    /**
     * 获取心跳统计
     */
    getStats() {
        return {
            active: this.heartbeats.size,
        };
    }

    /**
     * 清理所有心跳
     */
    clear() {
        for (const [streamId, state] of this.heartbeats.entries()) {
            if (state.timer) {
                clearInterval(state.timer);
            }
        }
        this.heartbeats.clear();
        logger.info("All heartbeats cleared");
    }
}

// 单例实例
export const heartbeatManager = new HeartbeatManager();
