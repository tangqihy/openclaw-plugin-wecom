import { logger } from "./logger.js";
import { prepareImageForMsgItem } from "./image-processor.js";

/**
 * 流式消息状态管理器
 * 管理所有活跃的流式消息会话,支持企业微信的流式刷新机制
 */
class StreamManager {
    constructor() {
        // streamId -> { content: string, finished: boolean, updatedAt: number, feedbackId: string|null, msgItem: Array, pendingImages: Array }
        this.streams = new Map();
        this._cleanupInterval = null;
    }

    /**
     * 启动定时清理（避免在 import 时产生常驻 side-effect）
     */
    startCleanup() {
        if (this._cleanupInterval) return;
        this._cleanupInterval = setInterval(() => this.cleanup(), 60 * 1000);
        // 不阻止进程退出（例如 npm pack / import smoke test）
        this._cleanupInterval.unref?.();
    }

    stopCleanup() {
        if (!this._cleanupInterval) return;
        clearInterval(this._cleanupInterval);
        this._cleanupInterval = null;
    }

    /**
     * 创建新的流式会话
     * @param {string} streamId - 流ID
     * @param {object} options - 可选配置
     * @param {string} options.feedbackId - 反馈追踪ID (最长256字节)
     */
    createStream(streamId, options = {}) {
        this.startCleanup();
        logger.debug("Creating stream", { streamId, feedbackId: options.feedbackId });
        this.streams.set(streamId, {
            content: "",
            finished: false,
            updatedAt: Date.now(),
            feedbackId: options.feedbackId || null,  // 用户反馈追踪
            msgItem: [],  // 图文混排消息列表
            pendingImages: [],  // 待处理的图片路径列表
        });
        return streamId;
    }

    /**
     * 更新流的内容 (增量或全量)
     * @param {string} streamId - 流ID
     * @param {string} content - 消息内容 (最长20480字节)
     * @param {boolean} finished - 是否完成
     * @param {object} options - 可选配置
     * @param {Array} options.msgItem - 图文混排列表 (仅finish=true时有效)
     */
    updateStream(streamId, content, finished = false, options = {}) {
        this.startCleanup();
        const stream = this.streams.get(streamId);
        if (!stream) {
            logger.warn("Stream not found for update", { streamId });
            return false;
        }

        // 检查内容长度 (企业微信限制20480字节)
        const contentBytes = Buffer.byteLength(content, 'utf8');
        if (contentBytes > 20480) {
            logger.warn("Stream content exceeds 20480 bytes, truncating", {
                streamId,
                bytes: contentBytes
            });
            // 截断到20480字节
            content = Buffer.from(content, 'utf8').slice(0, 20480).toString('utf8');
        }

        stream.content = content;
        stream.finished = finished;
        stream.updatedAt = Date.now();

        // 图文混排仅在完成时支持
        if (finished && options.msgItem && options.msgItem.length > 0) {
            stream.msgItem = options.msgItem.slice(0, 10);  // 最多10个
        }

        logger.debug("Stream updated", {
            streamId,
            contentLength: content.length,
            contentBytes,
            finished,
            hasMsgItem: stream.msgItem.length > 0
        });

        return true;
    }

    /**
     * 追加内容到流 (用于流式生成)
     */
    appendStream(streamId, chunk) {
        this.startCleanup();
        const stream = this.streams.get(streamId);
        if (!stream) {
            logger.warn("Stream not found for append", { streamId });
            return false;
        }

        const newContent = stream.content + chunk;

        // 检查内容长度 (企业微信限制20480字节)
        const contentBytes = Buffer.byteLength(newContent, 'utf8');
        if (contentBytes > 20480) {
            logger.warn("Stream content would exceed 20480 bytes on append, truncating", {
                streamId,
                bytes: contentBytes
            });
            stream.content = Buffer.from(newContent, 'utf8').slice(0, 20480).toString('utf8');
        } else {
            stream.content = newContent;
        }

        stream.updatedAt = Date.now();

        logger.debug("Stream appended", {
            streamId,
            chunkLength: chunk.length,
            totalLength: stream.content.length,
            contentBytes: Math.min(contentBytes, 20480)
        });

        return true;
    }

    /**
     * Queue image for inclusion when stream finishes
     * @param {string} streamId - 流ID
     * @param {string} imagePath - 图片绝对路径
     * @returns {boolean} 是否成功队列
     */
    queueImage(streamId, imagePath) {
        this.startCleanup();
        const stream = this.streams.get(streamId);
        if (!stream) {
            logger.warn("Stream not found for queueImage", { streamId });
            return false;
        }

        stream.pendingImages.push({
            path: imagePath,
            queuedAt: Date.now()
        });

        logger.debug("Image queued for stream", {
            streamId,
            imagePath,
            totalQueued: stream.pendingImages.length
        });

        return true;
    }

    /**
     * Process all pending images and build msgItem array
     * @param {string} streamId - 流ID
     * @returns {Promise<Array>} msg_item 数组
     */
    async processPendingImages(streamId) {
        const stream = this.streams.get(streamId);
        if (!stream || stream.pendingImages.length === 0) {
            return [];
        }

        logger.debug("Processing pending images", {
            streamId,
            count: stream.pendingImages.length
        });

        const msgItems = [];

        for (const img of stream.pendingImages) {
            try {
                // Limit to 10 images per WeCom API spec
                if (msgItems.length >= 10) {
                    logger.warn("Stream exceeded 10 image limit, truncating", {
                        streamId,
                        total: stream.pendingImages.length,
                        processed: msgItems.length
                    });
                    break;
                }

                const processed = await prepareImageForMsgItem(img.path);
                msgItems.push({
                    msgtype: "image",
                    image: {
                        base64: processed.base64,
                        md5: processed.md5
                    }
                });

                logger.debug("Image processed successfully", {
                    streamId,
                    imagePath: img.path,
                    format: processed.format,
                    size: processed.size
                });
            } catch (error) {
                logger.error("Failed to process image for stream", {
                    streamId,
                    imagePath: img.path,
                    error: error.message
                });
                // Continue processing other images even if one fails
            }
        }

        logger.info("Completed processing images for stream", {
            streamId,
            processed: msgItems.length,
            pending: stream.pendingImages.length
        });

        return msgItems;
    }

    /**
     * 标记流为完成状态（异步，处理待发送的图片）
     */
    async finishStream(streamId) {
        this.startCleanup();
        const stream = this.streams.get(streamId);
        if (!stream) {
            logger.warn("Stream not found for finish", { streamId });
            return false;
        }

        // Guard: skip if already finished to prevent duplicate image processing
        if (stream.finished) {
            logger.debug("Stream already finished, skipping", { streamId });
            return false;
        }

        // Process pending images before finishing
        if (stream.pendingImages.length > 0) {
            stream.msgItem = await this.processPendingImages(streamId);
        }

        stream.finished = true;
        stream.updatedAt = Date.now();

        logger.info("Stream finished", {
            streamId,
            contentLength: stream.content.length,
            imageCount: stream.msgItem.length
        });

        return true;
    }

    /**
     * 获取流的当前状态
     */
    getStream(streamId) {
        return this.streams.get(streamId);
    }

    /**
     * 检查流是否存在
     */
    hasStream(streamId) {
        return this.streams.has(streamId);
    }

    /**
     * 删除流
     */
    deleteStream(streamId) {
        const deleted = this.streams.delete(streamId);
        if (deleted) {
            logger.debug("Stream deleted", { streamId });
        }
        return deleted;
    }

    /**
     * 设置流过期时间（可通过配置调整）
     * @param {number} ms - 过期时间（毫秒）
     */
    setExpiry(ms) {
        this._expiryMs = ms;
    }

    /**
     * 清理超过过期时间未更新的流
     */
    cleanup() {
        const now = Date.now();
        const timeout = this._expiryMs || 10 * 60 * 1000;
        let cleaned = 0;

        for (const [streamId, stream] of this.streams.entries()) {
            if (now - stream.updatedAt > timeout) {
                this.streams.delete(streamId);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            logger.info("Cleaned up expired streams", { count: cleaned });
        }
    }

    /**
     * 获取统计信息
     */
    getStats() {
        const total = this.streams.size;
        let finished = 0;
        let active = 0;

        for (const stream of this.streams.values()) {
            if (stream.finished) {
                finished++;
            } else {
                active++;
            }
        }

        return { total, finished, active };
    }
}

// 单例实例
export const streamManager = new StreamManager();
