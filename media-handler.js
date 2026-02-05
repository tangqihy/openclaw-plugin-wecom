import { logger } from "./logger.js";

/**
 * 多媒体消息处理器
 * 处理图片和语音消息，转换为文本或多模态格式
 */

/**
 * 获取媒体处理配置
 */
export function getMediaConfig(config) {
    const wecom = config?.channels?.wecom || {};
    const media = wecom.media || {};
    
    return {
        // 图片处理
        imageEnabled: media.imageHandler !== "none",
        imageHandler: media.imageHandler || "passthrough",  // "vision-ai" | "passthrough" | "none"
        visionApiEndpoint: media.visionApiEndpoint || null,
        visionApiKey: media.visionApiKey || null,
        visionModel: media.visionModel || "gpt-4-vision-preview",
        
        // 语音处理
        voiceEnabled: media.voiceHandler !== "none",
        voiceHandler: media.voiceHandler || "passthrough",  // "asr" | "passthrough" | "none"
        asrApiEndpoint: media.asrApiEndpoint || null,
        asrApiKey: media.asrApiKey || null,
        
        // 通用配置
        maxImageSize: media.maxImageSize || 10 * 1024 * 1024,  // 10MB
        maxVoiceDuration: media.maxVoiceDuration || 60,  // 60 seconds
    };
}

/**
 * 处理图片消息
 * @param {object} message - 图片消息对象
 * @param {object} config - openclaw 配置
 * @returns {object} { textContent, imageUrl, isMultimodal }
 */
export async function handleImage(message, config) {
    const mediaConfig = getMediaConfig(config);
    const imageUrl = message.imageUrl;
    
    if (!imageUrl) {
        logger.warn("Image message has no imageUrl", { msgId: message.msgId });
        return {
            textContent: "[图片无法识别]",
            imageUrl: null,
            isMultimodal: false,
        };
    }
    
    logger.info("Processing image message", { 
        handler: mediaConfig.imageHandler,
        imageUrl: imageUrl.substring(0, 50) + "..."
    });

    // 处理方式：直通（传递给支持视觉的 AI）
    if (mediaConfig.imageHandler === "passthrough") {
        return {
            textContent: "[用户发送了一张图片]",
            imageUrl: imageUrl,
            isMultimodal: true,
            mediaType: "image",
        };
    }

    // 处理方式：调用视觉 AI 识别
    if (mediaConfig.imageHandler === "vision-ai" && mediaConfig.visionApiEndpoint) {
        try {
            const description = await callVisionApi(imageUrl, mediaConfig);
            return {
                textContent: `[图片内容]: ${description}`,
                imageUrl: imageUrl,
                isMultimodal: false,  // 已转为文本
            };
        } catch (err) {
            logger.error("Vision API call failed", { error: err.message });
            return {
                textContent: "[图片识别失败，请稍后重试]",
                imageUrl: imageUrl,
                isMultimodal: true,
            };
        }
    }

    // 默认：简单提示
    return {
        textContent: "[用户发送了一张图片]",
        imageUrl: imageUrl,
        isMultimodal: true,
        mediaType: "image",
    };
}

/**
 * 处理语音消息
 * @param {object} message - 语音消息对象
 * @param {object} config - openclaw 配置
 * @returns {object} { textContent, voiceUrl, transcribed }
 */
export async function handleVoice(message, config) {
    const mediaConfig = getMediaConfig(config);
    const voiceUrl = message.voiceUrl;
    const mediaId = message.mediaId;
    
    if (!voiceUrl && !mediaId) {
        logger.warn("Voice message has no voiceUrl or mediaId", { msgId: message.msgId });
        return {
            textContent: "[语音无法识别]",
            voiceUrl: null,
            transcribed: false,
        };
    }
    
    logger.info("Processing voice message", { 
        handler: mediaConfig.voiceHandler,
        hasVoiceUrl: !!voiceUrl,
        hasMediaId: !!mediaId
    });

    // 处理方式：调用 ASR 转文字
    if (mediaConfig.voiceHandler === "asr" && mediaConfig.asrApiEndpoint) {
        try {
            const transcription = await callAsrApi(voiceUrl || mediaId, mediaConfig);
            return {
                textContent: transcription,
                voiceUrl: voiceUrl,
                transcribed: true,
            };
        } catch (err) {
            logger.error("ASR API call failed", { error: err.message });
            return {
                textContent: "[语音转文字失败，请稍后重试]",
                voiceUrl: voiceUrl,
                transcribed: false,
            };
        }
    }

    // 处理方式：直通（需要 AI 支持语音）
    if (mediaConfig.voiceHandler === "passthrough") {
        return {
            textContent: "[用户发送了一条语音消息]",
            voiceUrl: voiceUrl,
            mediaId: mediaId,
            transcribed: false,
            mediaType: "voice",
        };
    }

    // 默认：提示不支持
    return {
        textContent: "[语音消息暂不支持，请发送文字]",
        voiceUrl: voiceUrl,
        transcribed: false,
    };
}

/**
 * 调用视觉 AI API
 * 示例实现，支持 OpenAI 兼容接口
 */
async function callVisionApi(imageUrl, mediaConfig) {
    const endpoint = mediaConfig.visionApiEndpoint;
    const apiKey = mediaConfig.visionApiKey;
    
    if (!endpoint || !apiKey) {
        throw new Error("Vision API not configured");
    }

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model: mediaConfig.visionModel,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "请描述这张图片的内容，简洁明了。",
                        },
                        {
                            type: "image_url",
                            image_url: { url: imageUrl },
                        },
                    ],
                },
            ],
            max_tokens: 500,
        }),
        signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
        throw new Error(`Vision API HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "无法识别图片内容";
}

/**
 * 调用语音识别 API
 * 示例实现，支持 OpenAI Whisper 兼容接口
 */
async function callAsrApi(voiceUrlOrMediaId, mediaConfig) {
    const endpoint = mediaConfig.asrApiEndpoint;
    const apiKey = mediaConfig.asrApiKey;
    
    if (!endpoint || !apiKey) {
        throw new Error("ASR API not configured");
    }

    // 首先下载语音文件
    const voiceResponse = await fetch(voiceUrlOrMediaId, {
        signal: AbortSignal.timeout(30000),
    });
    
    if (!voiceResponse.ok) {
        throw new Error(`Failed to download voice: HTTP ${voiceResponse.status}`);
    }

    const voiceBlob = await voiceResponse.blob();
    
    // 构建 FormData
    const formData = new FormData();
    formData.append("file", voiceBlob, "audio.amr");
    formData.append("model", "whisper-1");
    formData.append("language", "zh");

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
        },
        body: formData,
        signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
        throw new Error(`ASR API HTTP ${response.status}`);
    }

    const data = await response.json();
    return data.text || "";
}

/**
 * 处理混合消息（包含多种类型）
 */
export async function handleMixed(message, config) {
    // 混合消息暂时返回提示
    logger.warn("Mixed message type received", { msgId: message.msgId });
    return {
        textContent: "[收到混合消息，暂时仅支持文本部分]",
        isMultimodal: false,
    };
}

/**
 * 统一消息预处理入口
 * @param {object} message - 原始消息对象
 * @param {object} config - openclaw 配置
 * @returns {object} 处理后的消息
 */
export async function preprocessMessage(message, config) {
    const msgType = message.msgType;
    
    switch (msgType) {
        case "text":
            return {
                type: "text",
                content: message.content,
                isMultimodal: false,
                original: message,
            };
            
        case "image":
            const imageResult = await handleImage(message, config);
            return {
                type: "image",
                content: imageResult.textContent,
                imageUrl: imageResult.imageUrl,
                isMultimodal: imageResult.isMultimodal,
                original: message,
            };
            
        case "voice":
            const voiceResult = await handleVoice(message, config);
            return {
                type: "voice",
                content: voiceResult.textContent,
                voiceUrl: voiceResult.voiceUrl,
                transcribed: voiceResult.transcribed,
                isMultimodal: false,  // 语音转文字后不再是多模态
                original: message,
            };
            
        case "mixed":
            const mixedResult = await handleMixed(message, config);
            return {
                type: "mixed",
                content: mixedResult.textContent,
                isMultimodal: mixedResult.isMultimodal,
                original: message,
            };
            
        default:
            logger.warn("Unknown message type in preprocessor", { msgType });
            return {
                type: "unknown",
                content: `[不支持的消息类型: ${msgType}]`,
                isMultimodal: false,
                original: message,
            };
    }
}
