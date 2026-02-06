import { logger } from "./logger.js";

/**
 * 消息队列管理器
 * 为每个用户/群维护消息队列，确保消息按顺序处理
 */
class MessageQueueManager {
    constructor() {
        // streamKey -> { processing: boolean, currentStreamId: string|null, queue: Message[] }
        this.queues = new Map();
        
        // 配置
        this.config = {
            maxQueueSize: 5,        // 每个用户/群最大队列长度
            queueFullMessage: "⚠️ 消息较多，请稍后再试。当前正在处理您的消息，请耐心等待。",
            waitingMessage: "⏳ 收到您的消息，正在排队处理中...",
        };
    }

    /**
     * 尝试处理消息
     * @param {string} streamKey - 用户/群标识
     * @param {object} message - 消息内容
     * @param {function} processor - 处理函数 (async)
     * @returns {object} { queued: boolean, position?: number, queueFull?: boolean }
     */
    async enqueue(streamKey, message, processor) {
        let queueState = this.queues.get(streamKey);
        
        if (!queueState) {
            queueState = {
                processing: false,
                currentStreamId: null,
                queue: [],
                _cleanupGen: 0,
            };
            this.queues.set(streamKey, queueState);
        }

        // 如果没有在处理中，直接处理
        if (!queueState.processing) {
            queueState.processing = true;
            queueState.currentStreamId = message.streamId;
            
            logger.debug("Message queue: processing immediately", { 
                streamKey, 
                streamId: message.streamId 
            });

            // 异步处理，不阻塞
            this._processMessage(streamKey, message, processor);
            
            return { queued: false };
        }

        // 检查队列是否已满
        if (queueState.queue.length >= this.config.maxQueueSize) {
            logger.warn("Message queue: queue full", { 
                streamKey, 
                queueSize: queueState.queue.length 
            });
            return { queued: false, queueFull: true };
        }

        // 加入队列
        queueState.queue.push({ message, processor });
        const position = queueState.queue.length;
        
        logger.info("Message queue: message queued", { 
            streamKey, 
            position,
            streamId: message.streamId 
        });

        return { queued: true, position };
    }

    /**
     * 处理消息并自动处理队列中下一条
     */
    async _processMessage(streamKey, message, processor) {
        try {
            await processor(message);
        } catch (err) {
            logger.error("Message queue: processor error", { 
                streamKey, 
                error: err.message 
            });
        } finally {
            // 处理完成，检查队列
            this._processNext(streamKey);
        }
    }

    /**
     * 处理队列中的下一条消息
     */
    _processNext(streamKey) {
        const queueState = this.queues.get(streamKey);
        if (!queueState) return;

        // 取出下一条消息
        const next = queueState.queue.shift();
        
        if (next) {
            logger.info("Message queue: processing next", { 
                streamKey, 
                remainingQueue: queueState.queue.length,
                streamId: next.message.streamId 
            });
            
            queueState.currentStreamId = next.message.streamId;
            this._processMessage(streamKey, next.message, next.processor);
        } else {
            // 队列已空
            queueState.processing = false;
            queueState.currentStreamId = null;
            
            logger.debug("Message queue: queue empty", { streamKey });
            
            // 使用 generation 计数器避免清理时竞态：
            // 在设定延迟清理前记住当前 generation，清理时若 generation 已变则跳过
            const gen = ++queueState._cleanupGen;
            queueState._cleanupGen = gen;
            setTimeout(() => {
                const state = this.queues.get(streamKey);
                if (state && !state.processing && state.queue.length === 0 && state._cleanupGen === gen) {
                    this.queues.delete(streamKey);
                    logger.debug("Message queue: cleaned up empty queue", { streamKey });
                }
            }, 60000); // 1分钟后清理
        }
    }

    /**
     * 检查是否正在处理
     */
    isProcessing(streamKey) {
        const queueState = this.queues.get(streamKey);
        return queueState?.processing ?? false;
    }

    /**
     * 获取队列长度
     */
    getQueueLength(streamKey) {
        const queueState = this.queues.get(streamKey);
        return queueState?.queue.length ?? 0;
    }

    /**
     * 获取当前处理中的 streamId
     */
    getCurrentStreamId(streamKey) {
        const queueState = this.queues.get(streamKey);
        return queueState?.currentStreamId ?? null;
    }

    /**
     * 取消当前处理（标记，实际取消需要处理函数支持）
     */
    cancel(streamKey) {
        const queueState = this.queues.get(streamKey);
        if (!queueState) return false;
        
        // 清空队列
        const cancelled = queueState.queue.length;
        queueState.queue = [];
        
        logger.info("Message queue: cancelled", { streamKey, cancelled });
        return cancelled;
    }

    /**
     * 清空特定用户的队列并重置状态
     */
    reset(streamKey) {
        const queueState = this.queues.get(streamKey);
        if (queueState) {
            queueState.queue = [];
            queueState.processing = false;
            queueState.currentStreamId = null;
        }
        logger.debug("Message queue: reset", { streamKey });
    }

    /**
     * 获取统计信息
     */
    getStats() {
        let totalQueued = 0;
        let totalProcessing = 0;
        
        for (const [, state] of this.queues.entries()) {
            totalQueued += state.queue.length;
            if (state.processing) totalProcessing++;
        }
        
        return {
            activeQueues: this.queues.size,
            processing: totalProcessing,
            queued: totalQueued,
        };
    }

    /**
     * 获取配置的消息
     */
    getQueueFullMessage() {
        return this.config.queueFullMessage;
    }

    getWaitingMessage(position) {
        if (position === 1) {
            return "⏳ 收到您的消息，将在当前消息处理完成后立即处理。";
        }
        return `⏳ 收到您的消息，当前排在第 ${position} 位，请稍候...`;
    }
}

// 单例实例
export const messageQueue = new MessageQueueManager();
