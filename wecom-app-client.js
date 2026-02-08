import { logger } from "./logger.js";
import { TTLCache, withRetry, parseWecomError, buildApiUrl, CONSTANTS } from "./utils.js";

/**
 * 企业微信自建应用 API 客户端
 * 用于主动推送消息和模板卡片
 *
 * 需要配置：
 *   channels.wecom.app.corpId     - 企业 ID
 *   channels.wecom.app.corpSecret - 应用密钥
 *   channels.wecom.app.agentId    - 应用 agent ID
 */

const TOKEN_REFRESH_MARGIN_MS = 200 * 1000; // 提前 200 秒刷新

class WecomAppClient {
    constructor() {
        // access_token 缓存（TTL 略短于 7200s，留出安全余量）
        this._tokenCache = new TTLCache({ ttl: 7200 * 1000 });
        this._config = null;
        this._logger = logger.child("app-client");
    }

    // =========================================================================
    // 配置
    // =========================================================================

    /**
     * 设置应用配置
     * @param {{ corpId: string, corpSecret: string, agentId: number, enabled?: boolean }} config
     */
    configure(config) {
        if (!config || !config.corpId || !config.corpSecret || !config.agentId) {
            this._logger.warn("WecomAppClient: incomplete config, proactive push disabled", {
                hasCorpId: !!config?.corpId,
                hasSecret: !!config?.corpSecret,
                hasAgentId: !!config?.agentId,
            });
            this._config = null;
            return;
        }
        this._config = {
            corpId: config.corpId,
            corpSecret: config.corpSecret,
            agentId: config.agentId,
            enabled: config.enabled !== false,
        };
        this._logger.info("WecomAppClient configured", { corpId: config.corpId, agentId: config.agentId });
    }

    /**
     * 是否可用（已配置且已启用）
     */
    isAvailable() {
        return !!(this._config && this._config.enabled);
    }

    // =========================================================================
    // Access Token 管理
    // =========================================================================

    /**
     * 获取 access_token（自动缓存和刷新）
     * @returns {Promise<string>}
     */
    async getAccessToken() {
        if (!this._config) {
            throw new Error("WecomAppClient not configured");
        }

        // 检查缓存
        const cached = this._tokenCache.get(CONSTANTS.TOKEN_CACHE_KEY);
        if (cached) {
            return cached;
        }

        // 请求新 token
        return await this._fetchAccessToken();
    }

    /**
     * 从 API 获取新的 access_token
     */
    async _fetchAccessToken() {
        const url = buildApiUrl("/cgi-bin/gettoken", {
            corpid: this._config.corpId,
            corpsecret: this._config.corpSecret,
        });

        this._logger.debug("Fetching new access_token");

        const resp = await fetch(url, {
            method: "GET",
            signal: AbortSignal.timeout(CONSTANTS.API_TIMEOUT_MS),
        });

        if (!resp.ok) {
            throw new Error(`Failed to get access_token: HTTP ${resp.status}`);
        }

        const data = await resp.json();

        if (data.errcode !== 0) {
            const errorInfo = parseWecomError(data.errcode, data.errmsg);
            throw new Error(`Failed to get access_token: [${data.errcode}] ${errorInfo.message}`);
        }

        const token = data.access_token;
        const expiresIn = data.expires_in || 7200; // 秒

        // 缓存（提前 200s 过期以保证刷新窗口）
        const ttl = Math.max((expiresIn * 1000) - TOKEN_REFRESH_MARGIN_MS, 60000);
        this._tokenCache.set(CONSTANTS.TOKEN_CACHE_KEY, token, ttl);

        this._logger.info("Access token obtained", { expiresIn, cacheTtl: Math.round(ttl / 1000) });
        return token;
    }

    /**
     * 强制刷新 access_token
     */
    async refreshAccessToken() {
        this._tokenCache.delete(CONSTANTS.TOKEN_CACHE_KEY);
        return await this._fetchAccessToken();
    }

    // =========================================================================
    // 消息发送
    // =========================================================================

    /**
     * 通用消息发送
     * @param {string} toUser - 接收者 userId（多人用 | 分隔），或 "@all"
     * @param {string} msgType - 消息类型
     * @param {object} content - 消息体
     * @returns {Promise<object>}
     */
    async sendMessage(toUser, msgType, content) {
        if (!this.isAvailable()) {
            throw new Error("WecomAppClient not available");
        }

        return await withRetry(async () => {
            const token = await this.getAccessToken();
            const url = buildApiUrl("/cgi-bin/message/send", { access_token: token });

            const body = {
                touser: toUser,
                msgtype: msgType,
                agentid: this._config.agentId,
                ...content,
            };

            this._logger.debug("Sending message", { toUser, msgType });

            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(CONSTANTS.API_TIMEOUT_MS),
            });

            if (!resp.ok) {
                throw new Error(`Message send failed: HTTP ${resp.status}`);
            }

            const data = await resp.json();

            // 处理 token 过期的情况：自动刷新后重试
            if (data.errcode === 42001 || data.errcode === 40014) {
                this._logger.warn("Access token expired, refreshing", { errcode: data.errcode });
                await this.refreshAccessToken();
                throw new Error(`Token expired: ${data.errcode}`); // 触发重试
            }

            if (data.errcode !== 0) {
                const errorInfo = parseWecomError(data.errcode, data.errmsg);
                if (errorInfo.retryable) {
                    throw new Error(`Message send failed: [${data.errcode}] ${errorInfo.message}`);
                }
                // 不可重试的错误直接返回
                this._logger.error("Message send non-retryable error", { errcode: data.errcode, errmsg: data.errmsg });
                return data;
            }

            this._logger.info("Message sent successfully", { toUser, msgType });
            return data;
        }, {
            retries: CONSTANTS.DEFAULT_RETRY_COUNT,
            minTimeout: CONSTANTS.DEFAULT_RETRY_MIN_DELAY_MS,
            maxTimeout: CONSTANTS.DEFAULT_RETRY_MAX_DELAY_MS,
            onRetry: (error, attempt) => {
                this._logger.warn(`Message send retry ${attempt}`, { error: error.message });
            },
        });
    }

    /**
     * 发送模板卡片消息
     * @param {string} toUser - 接收者
     * @param {object} card - 模板卡片对象
     */
    async sendTemplateCard(toUser, card) {
        return await this.sendMessage(toUser, "template_card", {
            template_card: card,
        });
    }

    /**
     * 发送 Markdown 消息
     * @param {string} toUser - 接收者
     * @param {string} markdown - Markdown 内容
     */
    async sendMarkdown(toUser, markdown) {
        return await this.sendMessage(toUser, "markdown", {
            markdown: { content: markdown },
        });
    }

    /**
     * 发送文本消息
     * @param {string} toUser - 接收者
     * @param {string} text - 文本内容
     */
    async sendText(toUser, text) {
        return await this.sendMessage(toUser, "text", {
            text: { content: text },
        });
    }

    // =========================================================================
    // 媒体下载
    // =========================================================================

    /**
     * 下载临时素材（语音、文件等）
     * 调用企业微信 /cgi-bin/media/get 接口
     * @param {string} mediaId - 媒体文件 ID
     * @returns {Promise<{ buffer: Buffer, contentType: string, filename: string }>}
     */
    async downloadMedia(mediaId) {
        if (!this.isAvailable()) {
            throw new Error("WecomAppClient not available");
        }

        return await withRetry(async () => {
            const token = await this.getAccessToken();
            const url = buildApiUrl("/cgi-bin/media/get", {
                access_token: token,
                media_id: mediaId,
            });

            this._logger.debug("Downloading media", { mediaId });

            const resp = await fetch(url, {
                method: "GET",
                signal: AbortSignal.timeout(60000), // 媒体下载允许更长超时
            });

            if (!resp.ok) {
                throw new Error(`Media download failed: HTTP ${resp.status}`);
            }

            const contentType = resp.headers.get("content-type") || "";

            // 企业微信在 token 过期时返回 JSON 错误，不是二进制
            if (contentType.includes("application/json") || contentType.includes("text/plain")) {
                const data = await resp.json();
                if (data.errcode === 42001 || data.errcode === 40014) {
                    this._logger.warn("Access token expired during media download, refreshing", { errcode: data.errcode });
                    await this.refreshAccessToken();
                    throw new Error(`Token expired: ${data.errcode}`); // 触发重试
                }
                if (data.errcode) {
                    const errorInfo = parseWecomError(data.errcode, data.errmsg);
                    throw new Error(`Media download failed: [${data.errcode}] ${errorInfo.message}`);
                }
            }

            // 解析文件名（从 Content-Disposition 头）
            let filename = "media";
            const disposition = resp.headers.get("content-disposition") || "";
            const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/i);
            if (filenameMatch) {
                filename = filenameMatch[1].trim();
            } else {
                // 根据 content-type 推断扩展名
                if (contentType.includes("audio/amr")) filename = "voice.amr";
                else if (contentType.includes("audio/silk")) filename = "voice.silk";
                else if (contentType.includes("audio/")) filename = "voice.amr";
                else if (contentType.includes("image/")) filename = "image.jpg";
            }

            const buffer = Buffer.from(await resp.arrayBuffer());
            this._logger.info("Media downloaded", { mediaId, contentType, filename, size: buffer.length });

            return { buffer, contentType, filename };
        }, {
            retries: 2,
            minTimeout: 1000,
            maxTimeout: 5000,
            onRetry: (error, attempt) => {
                this._logger.warn(`Media download retry ${attempt}`, { error: error.message, mediaId });
            },
        });
    }

    /**
     * 获取统计信息
     */
    getStats() {
        return {
            available: this.isAvailable(),
            hasToken: this._tokenCache.has(CONSTANTS.TOKEN_CACHE_KEY),
        };
    }

    /**
     * 清理资源
     */
    destroy() {
        this._tokenCache.destroy();
        this._config = null;
    }
}

// 单例
export const wecomAppClient = new WecomAppClient();
