import { logger } from "./logger.js";

/**
 * 企业微信模板卡片构建器
 * 提供三种预定义卡片类型的工厂方法
 *
 * 文档: https://developer.work.weixin.qq.com/document/path/90236#模板卡片消息
 */

// ============================================================================
// 文本通知卡片 (text_notice)
// ============================================================================

/**
 * 构建文本通知卡片
 * @param {object} options
 * @param {string} options.title - 卡片标题（必填）
 * @param {string} options.description - 卡片描述
 * @param {string} [options.url] - 点击跳转链接
 * @param {string} [options.source] - 来源文字（左上角）
 * @param {string} [options.actionText] - 按钮文字（默认"查看详情"）
 * @param {Array<{key: string, value: string}>} [options.kvList] - 键值对列表
 * @returns {object} 模板卡片 JSON
 */
export function buildTextNoticeCard(options = {}) {
    const { title, description, url, source, actionText = "查看详情", kvList } = options;

    if (!title) {
        logger.warn("buildTextNoticeCard: title is required");
    }

    const card = {
        card_type: "text_notice",
        main_title: {
            title: title || "通知",
            desc: description || "",
        },
    };

    // 来源
    if (source) {
        card.source = {
            desc: source,
        };
    }

    // 键值对
    if (kvList && kvList.length > 0) {
        card.horizontal_content_list = kvList.slice(0, 6).map(kv => ({
            keyname: kv.key,
            value: kv.value,
            ...(kv.url ? { type: 1, url: kv.url } : {}),
        }));
    }

    // 跳转
    if (url) {
        card.card_action = {
            type: 1,
            url: url,
        };
    }

    return card;
}

// ============================================================================
// 按钮交互卡片 (button_interaction)
// ============================================================================

/**
 * 构建按钮交互卡片
 * @param {object} options
 * @param {string} options.title - 卡片标题（必填）
 * @param {string} [options.description] - 卡片描述
 * @param {string} [options.source] - 来源文字
 * @param {Array<{text: string, key: string, style?: number}>} options.buttons - 按钮列表
 *   - text: 按钮文字
 *   - key: 按钮回调 key（格式如 "retry::streamId", "feedback::positive::streamId"）
 *   - style: 1=主色, 2=灰色（默认1）
 * @returns {object} 模板卡片 JSON
 */
export function buildButtonCard(options = {}) {
    const { title, description, source, buttons = [] } = options;

    if (!title) {
        logger.warn("buildButtonCard: title is required");
    }

    const card = {
        card_type: "button_interaction",
        main_title: {
            title: title || "操作",
            desc: description || "",
        },
    };

    // 来源
    if (source) {
        card.source = {
            desc: source,
        };
    }

    // 按钮列表（最多 6 个）
    if (buttons.length > 0) {
        card.button_list = buttons.slice(0, 6).map(btn => ({
            text: btn.text,
            key: btn.key,
            style: btn.style || 1,
        }));
    }

    return card;
}

// ============================================================================
// 图文通知卡片 (news_notice)
// ============================================================================

/**
 * 构建图文通知卡片
 * @param {object} options
 * @param {string} options.title - 卡片标题（必填）
 * @param {string} [options.description] - 卡片描述
 * @param {string} [options.imageUrl] - 图片链接
 * @param {string} [options.url] - 点击跳转链接
 * @param {string} [options.source] - 来源文字
 * @returns {object} 模板卡片 JSON
 */
export function buildNewsCard(options = {}) {
    const { title, description, imageUrl, url, source } = options;

    if (!title) {
        logger.warn("buildNewsCard: title is required");
    }

    const card = {
        card_type: "news_notice",
        main_title: {
            title: title || "消息",
            desc: description || "",
        },
    };

    // 来源
    if (source) {
        card.source = {
            desc: source,
        };
    }

    // 图片
    if (imageUrl) {
        card.card_image = {
            url: imageUrl,
            aspect_ratio: 2.35,
        };
    }

    // 跳转
    if (url) {
        card.card_action = {
            type: 1,
            url: url,
        };
    }

    return card;
}

// ============================================================================
// AI 回复后交互卡片（预定义）
// ============================================================================

/**
 * 构建 AI 回复后的交互卡片
 * @param {string} streamId - 流 ID，用于回调追踪
 * @param {object} options
 * @param {boolean} [options.feedbackButtons=true] - 是否显示点赞/点踩按钮
 * @param {boolean} [options.retryButton=true] - 是否显示重试按钮
 * @param {string} [options.title] - 卡片标题
 * @returns {object} 模板卡片 JSON
 */
export function buildPostResponseCard(streamId, options = {}) {
    const {
        feedbackButtons = true,
        retryButton = true,
        title = "这个回答对你有帮助吗？",
    } = options;

    const buttons = [];

    if (feedbackButtons) {
        buttons.push({
            text: "👍 有用",
            key: `feedback::positive::${streamId}`,
            style: 1,
        });
        buttons.push({
            text: "👎 没用",
            key: `feedback::negative::${streamId}`,
            style: 2,
        });
    }

    if (retryButton) {
        buttons.push({
            text: "🔄 重试",
            key: `retry::${streamId}`,
            style: 2,
        });
    }

    if (buttons.length === 0) {
        return null; // 没有按钮则不发送卡片
    }

    return buildButtonCard({
        title,
        source: "AI 助手",
        buttons,
    });
}

// ============================================================================
// 通知推送卡片（预定义）
// ============================================================================

/**
 * 构建外部推送通知卡片
 * @param {object} options
 * @param {string} options.title - 通知标题
 * @param {string} [options.description] - 通知描述
 * @param {string} [options.url] - 详情链接
 * @param {string} [options.source] - 来源
 * @param {"text_notice"|"news_notice"} [options.cardType="text_notice"] - 卡片类型
 * @param {string} [options.imageUrl] - 图片（仅 news_notice）
 * @param {Array} [options.buttons] - 按钮列表（如提供则使用 button_interaction）
 * @returns {object} 模板卡片 JSON
 */
export function buildNotificationCard(options = {}) {
    const { title, description, url, source, cardType, imageUrl, buttons } = options;

    // 如果有按钮，使用 button_interaction
    if (buttons && buttons.length > 0) {
        return buildButtonCard({ title, description, source, buttons });
    }

    // 如果有图片，使用 news_notice
    if (cardType === "news_notice" || imageUrl) {
        return buildNewsCard({ title, description, imageUrl, url, source });
    }

    // 默认 text_notice
    return buildTextNoticeCard({ title, description, url, source });
}
