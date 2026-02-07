import { logger } from "./logger.js";
import { wecomAppClient } from "./wecom-app-client.js";
import { buildPostResponseCard } from "./card-builder.js";

/**
 * 主动推送服务
 * 封装所有通过自建应用 API 推送消息的逻辑
 *
 * 功能：
 *   - 即时推送文本/Markdown/卡片消息
 *   - 溢出内容分段推送（当流内容超过 18KB 时）
 *   - AI 回复后发送交互卡片（点赞/点踩/重试）
 *   - 速率限制（per-user）
 *   - 统计信息
 */

const OVERFLOW_CHUNK_SIZE = 18000; // 18KB per chunk (bytes)

class PushService {
    constructor() {
        this._logger = logger.child("push-svc");

        // 速率限制：userId -> lastPushTime
        this._rateLimits = new Map();

        // 配置
        this.config = {
            rateLimitMs: 1000,       // per-user 最小推送间隔（ms）
            overflowChunkSize: OVERFLOW_CHUNK_SIZE,
        };

        // 统计
        this._stats = {
            totalPushed: 0,
            totalFailed: 0,
            totalOverflows: 0,
            totalCards: 0,
        };
    }

    // =========================================================================
    // 可用性检查
    // =========================================================================

    isAvailable() {
        return wecomAppClient.isAvailable();
    }

    // =========================================================================
    // 速率限制
    // =========================================================================

    /**
     * 检查是否可以推送（速率限制）
     * @param {string} userId
     * @returns {boolean}
     */
    _checkRateLimit(userId) {
        const now = Date.now();
        const last = this._rateLimits.get(userId) || 0;
        if (now - last < this.config.rateLimitMs) {
            return false;
        }
        this._rateLimits.set(userId, now);
        return true;
    }

    /**
     * 等待速率限制窗口
     * @param {string} userId
     */
    async _waitForRateLimit(userId) {
        const now = Date.now();
        const last = this._rateLimits.get(userId) || 0;
        const diff = this.config.rateLimitMs - (now - last);
        if (diff > 0) {
            await new Promise(resolve => setTimeout(resolve, diff));
        }
        this._rateLimits.set(userId, Date.now());
    }

    // =========================================================================
    // 推送方法
    // =========================================================================

    /**
     * 推送文本消息
     * @param {string} userId - 接收者
     * @param {string} text - 文本内容
     */
    async pushText(userId, text) {
        if (!this.isAvailable()) {
            this._logger.debug("Push service not available, skipping text push");
            return null;
        }

        await this._waitForRateLimit(userId);

        try {
            const result = await wecomAppClient.sendText(userId, text);
            this._stats.totalPushed++;
            return result;
        } catch (err) {
            this._stats.totalFailed++;
            this._logger.error("Failed to push text", { userId, error: err.message });
            return null;
        }
    }

    /**
     * 推送 Markdown 消息
     * @param {string} userId - 接收者
     * @param {string} markdown - Markdown 内容
     */
    async pushMarkdown(userId, markdown) {
        if (!this.isAvailable()) {
            this._logger.debug("Push service not available, skipping markdown push");
            return null;
        }

        await this._waitForRateLimit(userId);

        try {
            const result = await wecomAppClient.sendMarkdown(userId, markdown);
            this._stats.totalPushed++;
            return result;
        } catch (err) {
            this._stats.totalFailed++;
            this._logger.error("Failed to push markdown", { userId, error: err.message });
            return null;
        }
    }

    /**
     * 推送模板卡片
     * @param {string} userId - 接收者
     * @param {object} card - 模板卡片 JSON
     */
    async pushCard(userId, card) {
        if (!this.isAvailable()) {
            this._logger.debug("Push service not available, skipping card push");
            return null;
        }

        await this._waitForRateLimit(userId);

        try {
            const result = await wecomAppClient.sendTemplateCard(userId, card);
            this._stats.totalPushed++;
            this._stats.totalCards++;
            return result;
        } catch (err) {
            this._stats.totalFailed++;
            this._logger.error("Failed to push card", { userId, error: err.message });
            return null;
        }
    }

    // =========================================================================
    // 溢出内容推送
    // =========================================================================

    /**
     * 推送溢出内容（分段发送）
     * 当流式消息超过 18KB 时，将剩余内容通过自建应用分段推送
     *
     * @param {string} userId - 接收者
     * @param {string} content - 溢出的内容
     * @param {string} streamId - 关联的流 ID
     */
    async pushOverflow(userId, content, streamId) {
        if (!this.isAvailable()) {
            this._logger.warn("Push service not available, overflow content lost", {
                userId,
                streamId,
                contentLength: content.length,
            });
            return;
        }

        this._stats.totalOverflows++;
        this._logger.info("Pushing overflow content", {
            userId,
            streamId,
            contentBytes: Buffer.byteLength(content, "utf8"),
        });

        // 按字节分段
        const chunks = this._splitByBytes(content, this.config.overflowChunkSize);

        for (let i = 0; i < chunks.length; i++) {
            const header = chunks.length > 1
                ? `**续 (${i + 1}/${chunks.length})：**\n\n`
                : "**续：**\n\n";

            await this._waitForRateLimit(userId);

            try {
                await wecomAppClient.sendMarkdown(userId, header + chunks[i]);
                this._stats.totalPushed++;
                this._logger.debug("Overflow chunk sent", {
                    userId,
                    chunk: `${i + 1}/${chunks.length}`,
                });
            } catch (err) {
                this._stats.totalFailed++;
                this._logger.error("Failed to push overflow chunk", {
                    userId,
                    chunk: `${i + 1}/${chunks.length}`,
                    error: err.message,
                });
                // 继续尝试发送后续分段
            }
        }
    }

    /**
     * 按字节大小分割文本
     * @param {string} text
     * @param {number} maxBytes
     * @returns {string[]}
     */
    _splitByBytes(text, maxBytes) {
        const chunks = [];
        let start = 0;

        while (start < text.length) {
            // 二分查找适合的字符位置
            let end = text.length;
            let slice = text.substring(start, end);

            if (Buffer.byteLength(slice, "utf8") <= maxBytes) {
                chunks.push(slice);
                break;
            }

            // 粗略估算（UTF-8 平均每字符约 3 字节用于中文）
            let estimate = Math.floor(maxBytes / 3);
            end = Math.min(start + estimate, text.length);

            // 向前调整到合适大小
            slice = text.substring(start, end);
            while (Buffer.byteLength(slice, "utf8") > maxBytes && end > start + 1) {
                end = Math.floor(start + (end - start) * 0.9);
                slice = text.substring(start, end);
            }

            // 向后扩展到极限
            while (end < text.length) {
                const next = text.substring(start, end + 1);
                if (Buffer.byteLength(next, "utf8") > maxBytes) break;
                end++;
                slice = next;
            }

            // 尝试在换行处断开
            const lastNewline = slice.lastIndexOf("\n");
            if (lastNewline > slice.length * 0.3) {
                end = start + lastNewline + 1;
                slice = text.substring(start, end);
            }

            chunks.push(slice);
            start = end;
        }

        return chunks;
    }

    // =========================================================================
    // AI 回复后交互卡片
    // =========================================================================

    /**
     * AI 回复完成后发送交互卡片（点赞/点踩/重试）
     * @param {string} userId - 接收者
     * @param {string} streamId - 流 ID
     * @param {object} [cardConfig] - 卡片配置
     * @param {boolean} [cardConfig.feedbackButtons] - 是否显示点赞/点踩
     * @param {boolean} [cardConfig.retryButton] - 是否显示重试
     */
    async pushPostResponseCard(userId, streamId, cardConfig = {}) {
        if (!this.isAvailable()) {
            return null;
        }

        const card = buildPostResponseCard(streamId, cardConfig);
        if (!card) {
            return null;
        }

        this._logger.debug("Sending post-response card", { userId, streamId });
        return await this.pushCard(userId, card);
    }

    // =========================================================================
    // 统计与清理
    // =========================================================================

    getStats() {
        return {
            available: this.isAvailable(),
            ...this._stats,
            rateLimitEntries: this._rateLimits.size,
        };
    }

    /**
     * 清理速率限制缓存（定期调用或关闭时调用）
     */
    cleanup() {
        const now = Date.now();
        const expiry = 60000; // 1 分钟无活动则清理

        for (const [userId, lastTime] of this._rateLimits.entries()) {
            if (now - lastTime > expiry) {
                this._rateLimits.delete(userId);
            }
        }
    }

    /**
     * 销毁服务
     */
    destroy() {
        this._rateLimits.clear();
        this._stats = { totalPushed: 0, totalFailed: 0, totalOverflows: 0, totalCards: 0 };
    }
}

// 单例
export const pushService = new PushService();
