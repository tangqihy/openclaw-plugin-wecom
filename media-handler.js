import { logger } from "./logger.js";
import { wecomAppClient } from "./wecom-app-client.js";
import { execFile } from "node:child_process";
import { writeFile, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 多媒体消息处理器
 * 处理图片、语音和文件消息，转换为文本或多模态格式
 */

// 支持直接读取内容的文本类文件扩展名
const TEXT_FILE_EXTENSIONS = new Set([
    ".txt", ".md", ".csv", ".json", ".log", ".xml",
    ".yaml", ".yml", ".ini", ".conf", ".cfg",
    ".js", ".ts", ".py", ".java", ".c", ".cpp", ".h",
    ".html", ".css", ".sql", ".sh", ".bat", ".ps1",
    ".env", ".gitignore", ".dockerfile",
]);

// 默认文件读取大小限制（50KB）
const DEFAULT_MAX_FILE_READ_SIZE = 50 * 1024;

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
        voiceHandler: media.voiceHandler || "auto",  // "asr" | "azure" | "auto" | "passthrough" | "none"
        asrProvider: media.asrProvider || "auto",     // "azure" | "whisper" | "auto" (自动检测)
        // Whisper 兼容 API
        asrApiEndpoint: media.asrApiEndpoint || null,
        asrApiKey: media.asrApiKey || null,
        // Azure Speech Service (支持环境变量)
        azureSpeechKey: media.azureSpeechKey || process.env.AZURE_SPEECH_KEY || null,
        azureSpeechRegion: media.azureSpeechRegion || process.env.AZURE_SPEECH_REGION || null,
        azureSpeechLang: media.azureSpeechLang || process.env.AZURE_SPEECH_LANG || "zh-CN",
        
        // 文件处理
        fileEnabled: media.fileHandler !== "none",
        fileHandler: media.fileHandler || "auto",  // "auto" | "passthrough" | "none"
        maxFileReadSize: media.maxFileReadSize || DEFAULT_MAX_FILE_READ_SIZE,
        
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
 * 
 * 流程:
 *   1. 优先使用 voiceUrl 直接下载语音
 *   2. 如果只有 mediaId，则通过企业微信 API 下载
 *   3. 下载后如果配置了 ASR，调用语音识别转文字
 *   4. 否则返回占位提示
 *
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

    // handler = "none": 直接忽略语音
    if (mediaConfig.voiceHandler === "none") {
        return {
            textContent: "[语音消息暂不支持，请发送文字]",
            voiceUrl: voiceUrl,
            transcribed: false,
        };
    }

    // handler = "passthrough": 不做转录，仅告知 AI
    if (mediaConfig.voiceHandler === "passthrough") {
        return {
            textContent: "[用户发送了一条语音消息]",
            voiceUrl: voiceUrl,
            mediaId: mediaId,
            transcribed: false,
            mediaType: "voice",
        };
    }

    // handler = "asr" / "azure" / "auto": 尝试下载并转录
    const hasWhisperConfig = mediaConfig.asrApiEndpoint && mediaConfig.asrApiKey;
    const hasAzureConfig = mediaConfig.azureSpeechKey && mediaConfig.azureSpeechRegion;
    const hasAsrConfig = hasWhisperConfig || hasAzureConfig;

    // 明确指定 ASR 模式但未配置
    if ((mediaConfig.voiceHandler === "asr" || mediaConfig.voiceHandler === "azure") && !hasAsrConfig) {
        logger.warn("ASR/Azure handler configured but no API credentials provided");
        return {
            textContent: "[语音转文字未配置，请联系管理员设置 Azure Speech 或 Whisper API]",
            voiceUrl: voiceUrl,
            transcribed: false,
        };
    }

    // "auto" 模式下如果没有 ASR 配置，退回占位提示
    if (mediaConfig.voiceHandler === "auto" && !hasAsrConfig) {
        logger.debug("Auto voice handler: no ASR configured, falling back to placeholder");
        return {
            textContent: "[用户发送了一条语音消息，语音转文字功能未配置]",
            voiceUrl: voiceUrl,
            transcribed: false,
        };
    }

    // ===== 下载语音 =====
    let voiceBuffer;
    let voiceFilename = "voice.amr";
    try {
        if (voiceUrl) {
            // 有直接 URL，直接下载
            logger.debug("Downloading voice from URL", { voiceUrl: voiceUrl.substring(0, 60) });
            const resp = await fetch(voiceUrl, {
                signal: AbortSignal.timeout(30000),
            });
            if (!resp.ok) {
                throw new Error(`Failed to download voice from URL: HTTP ${resp.status}`);
            }
            voiceBuffer = Buffer.from(await resp.arrayBuffer());
        } else if (mediaId && wecomAppClient.isAvailable()) {
            // 通过企业微信 API 下载
            logger.debug("Downloading voice via WeCom API", { mediaId });
            const media = await wecomAppClient.downloadMedia(mediaId);
            voiceBuffer = media.buffer;
            voiceFilename = media.filename || voiceFilename;
        } else {
            // 无法下载
            logger.warn("Cannot download voice: no URL and WeCom app client not available", { mediaId });
            return {
                textContent: "[语音无法下载，请确保已配置企业微信自建应用]",
                voiceUrl: voiceUrl,
                transcribed: false,
            };
        }

        logger.info("Voice downloaded", { size: voiceBuffer.length, filename: voiceFilename });
    } catch (err) {
        logger.error("Voice download failed", { error: err.message });
        return {
            textContent: "[语音下载失败，请稍后重试]",
            voiceUrl: voiceUrl,
            transcribed: false,
        };
    }

    // ===== ASR 转录 =====
    try {
        let transcription;

        // 选择 ASR 引擎：Azure 优先（如果配置了），然后 Whisper
        const useAzure = hasAzureConfig && (
            mediaConfig.asrProvider === "azure" ||
            mediaConfig.voiceHandler === "azure" ||
            (mediaConfig.asrProvider === "auto" && hasAzureConfig)
        );

        if (useAzure) {
            logger.info("Using Azure Speech STT", { region: mediaConfig.azureSpeechRegion });
            transcription = await callAzureSttApi(voiceBuffer, voiceFilename, mediaConfig);
        } else if (hasWhisperConfig) {
            logger.info("Using Whisper compatible ASR");
            transcription = await callWhisperApi(voiceBuffer, voiceFilename, mediaConfig);
        } else {
            throw new Error("No ASR provider configured");
        }

        if (!transcription || !transcription.trim()) {
            return {
                textContent: "[语音内容为空或无法识别]",
                voiceUrl: voiceUrl,
                transcribed: false,
            };
        }
        logger.info("Voice transcribed successfully", { length: transcription.length, provider: useAzure ? "azure" : "whisper" });
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

// ============================================================================
// 音频格式转换 (AMR → WAV)
// ============================================================================

/**
 * 使用 ffmpeg 将音频转换为 16kHz mono PCM WAV
 * Azure Speech REST API 要求 WAV 格式
 *
 * @param {Buffer} audioBuffer - 原始音频数据
 * @param {string} inputExt - 输入格式扩展名（如 ".amr"）
 * @returns {Promise<Buffer>} WAV 格式音频
 */
async function convertAudioToWav(audioBuffer, inputExt = ".amr") {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tmpInput = join(tmpdir(), `stt_in_${id}${inputExt}`);
    const tmpOutput = join(tmpdir(), `stt_out_${id}.wav`);

    try {
        await writeFile(tmpInput, audioBuffer);
        await execFileAsync("ffmpeg", [
            "-y",                    // 覆盖输出
            "-i", tmpInput,          // 输入文件
            "-f", "wav",             // 输出格式 WAV
            "-ar", "16000",          // 采样率 16kHz
            "-ac", "1",              // 单声道
            "-acodec", "pcm_s16le",  // PCM 16-bit 小端
            tmpOutput,
        ], { timeout: 30000 });

        const wavBuffer = await readFile(tmpOutput);
        logger.debug("Audio converted to WAV", { inputSize: audioBuffer.length, outputSize: wavBuffer.length, inputExt });
        return wavBuffer;
    } catch (err) {
        if (err.code === "ENOENT") {
            throw new Error(
                "ffmpeg 未安装。请运行: apt install ffmpeg (Linux) 或 brew install ffmpeg (macOS)"
            );
        }
        throw new Error(`音频转换失败: ${err.message}`);
    } finally {
        await unlink(tmpInput).catch(() => {});
        await unlink(tmpOutput).catch(() => {});
    }
}

/**
 * 检查音频是否需要转换（非 WAV 格式）
 */
function needsConversion(filename) {
    const ext = (filename || "").split(".").pop()?.toLowerCase();
    return ext !== "wav";
}

// ============================================================================
// Azure Speech STT
// ============================================================================

/**
 * 调用 Azure Speech-to-Text REST API
 *
 * 文档: https://learn.microsoft.com/azure/ai-services/speech-service/rest-speech-to-text-short
 *
 * @param {Buffer} voiceBuffer - 语音文件二进制数据
 * @param {string} filename - 文件名（用于推断格式）
 * @param {object} mediaConfig - 媒体配置
 * @returns {Promise<string>} 转录文本
 */
async function callAzureSttApi(voiceBuffer, filename, mediaConfig) {
    const key = mediaConfig.azureSpeechKey;
    const region = mediaConfig.azureSpeechRegion;
    const lang = mediaConfig.azureSpeechLang || "zh-CN";

    if (!key || !region) {
        throw new Error("Azure Speech not configured: missing AZURE_SPEECH_KEY or AZURE_SPEECH_REGION");
    }

    // 如果不是 WAV 格式，先转换
    let wavBuffer = voiceBuffer;
    if (needsConversion(filename)) {
        const ext = (filename || "").includes(".") ? `.${filename.split(".").pop()}` : ".amr";
        logger.debug("Converting audio for Azure STT", { originalFormat: ext, size: voiceBuffer.length });
        wavBuffer = await convertAudioToWav(voiceBuffer, ext);
    }

    const sttUrl = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${lang}&format=detailed`;

    logger.debug("Calling Azure Speech STT", { region, lang, audioSize: wavBuffer.length });

    const response = await fetch(sttUrl, {
        method: "POST",
        headers: {
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
            "Accept": "application/json",
        },
        body: wavBuffer,
        signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`Azure STT HTTP ${response.status}: ${errorText.substring(0, 300)}`);
    }

    const data = await response.json();

    // Azure STT 返回格式:
    // { RecognitionStatus: "Success", DisplayText: "你好世界。", NBest: [...] }
    if (data.RecognitionStatus === "Success") {
        const text = data.DisplayText || data.NBest?.[0]?.Display || "";
        logger.info("Azure STT success", { text: text.substring(0, 50), confidence: data.NBest?.[0]?.Confidence });
        return text;
    } else if (data.RecognitionStatus === "NoMatch") {
        logger.warn("Azure STT: no speech recognized");
        return "";
    } else if (data.RecognitionStatus === "InitialSilenceTimeout") {
        logger.warn("Azure STT: initial silence timeout (no speech detected)");
        return "";
    } else {
        logger.warn("Azure STT unexpected status", { status: data.RecognitionStatus, data });
        return data.DisplayText || "";
    }
}

// ============================================================================
// Whisper 兼容 API
// ============================================================================

/**
 * 调用语音识别 API
 * 支持 OpenAI Whisper 兼容接口
 * @param {Buffer} voiceBuffer - 语音文件二进制数据
 * @param {string} filename - 文件名（用于推断格式）
 * @param {object} mediaConfig - 媒体配置
 * @returns {Promise<string>} 转录文本
 */
async function callWhisperApi(voiceBuffer, filename, mediaConfig) {
    const endpoint = mediaConfig.asrApiEndpoint;
    const apiKey = mediaConfig.asrApiKey;
    
    if (!endpoint || !apiKey) {
        throw new Error("Whisper API not configured");
    }

    logger.debug("Calling Whisper API", { endpoint, fileSize: voiceBuffer.length, filename });

    // 构建 FormData（Node.js 18+ 原生支持）
    const blob = new Blob([voiceBuffer], { type: "audio/amr" });
    const formData = new FormData();
    formData.append("file", blob, filename || "audio.amr");
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
        const errorText = await response.text().catch(() => "");
        throw new Error(`Whisper API HTTP ${response.status}: ${errorText.substring(0, 200)}`);
    }

    const data = await response.json();
    return data.text || "";
}

/**
 * 处理文件消息
 * 
 * 流程:
 *   1. 通过企业微信 API 下载文件
 *   2. 如果是文本类文件（txt、md、csv 等），读取内容发送给 AI
 *   3. 其他类型文件仅发送元数据描述
 *
 * @param {object} message - 文件消息对象 { mediaId, fileName, fileSize }
 * @param {object} config - openclaw 配置
 * @returns {object} { textContent, isMultimodal }
 */
export async function handleFile(message, config) {
    const mediaConfig = getMediaConfig(config);
    const mediaId = message.mediaId;
    const fileName = message.fileName || "unknown";
    const fileSize = message.fileSize || 0;

    logger.info("Processing file message", {
        handler: mediaConfig.fileHandler,
        fileName,
        fileSize,
        hasMediaId: !!mediaId,
    });

    // handler = "none": 忽略文件
    if (mediaConfig.fileHandler === "none" || !mediaConfig.fileEnabled) {
        return {
            textContent: `[用户发送了文件: ${fileName}（文件处理已禁用）]`,
            isMultimodal: false,
        };
    }

    // handler = "passthrough": 仅告知 AI
    if (mediaConfig.fileHandler === "passthrough") {
        const sizeStr = formatFileSize(fileSize);
        return {
            textContent: `[用户发送了文件: ${fileName} (${sizeStr})]`,
            isMultimodal: false,
        };
    }

    // handler = "auto": 尝试下载并读取文本文件
    if (!mediaId) {
        return {
            textContent: `[用户发送了文件: ${fileName}，但无法下载（缺少 media_id）]`,
            isMultimodal: false,
        };
    }

    if (!wecomAppClient.isAvailable()) {
        logger.warn("Cannot download file: WeCom app client not available");
        const sizeStr = formatFileSize(fileSize);
        return {
            textContent: `[用户发送了文件: ${fileName} (${sizeStr})，需要配置企业微信自建应用才能读取文件内容]`,
            isMultimodal: false,
        };
    }

    // 判断是否为文本类文件
    const ext = getFileExtension(fileName);
    const isTextFile = TEXT_FILE_EXTENSIONS.has(ext);

    if (!isTextFile) {
        // 非文本文件，仅返回元数据
        const sizeStr = formatFileSize(fileSize);
        logger.debug("Non-text file, returning metadata only", { fileName, ext });
        return {
            textContent: `[用户发送了文件: ${fileName} (${sizeStr})，该文件类型暂不支持内容读取]`,
            isMultimodal: false,
        };
    }

    // 检查文件大小限制
    const maxSize = mediaConfig.maxFileReadSize;
    if (fileSize > 0 && fileSize > maxSize) {
        const sizeStr = formatFileSize(fileSize);
        const maxStr = formatFileSize(maxSize);
        logger.warn("File too large for reading", { fileName, fileSize, maxSize });
        return {
            textContent: `[用户发送了文件: ${fileName} (${sizeStr})，文件超过读取限制 ${maxStr}，无法读取内容]`,
            isMultimodal: false,
        };
    }

    // 下载并读取文件
    try {
        const media = await wecomAppClient.downloadMedia(mediaId);

        // 二次检查实际下载大小
        if (media.buffer.length > maxSize) {
            const sizeStr = formatFileSize(media.buffer.length);
            const maxStr = formatFileSize(maxSize);
            return {
                textContent: `[用户发送了文件: ${fileName} (${sizeStr})，文件超过读取限制 ${maxStr}]`,
                isMultimodal: false,
            };
        }

        // 读取文本内容
        const textContent = media.buffer.toString("utf-8");
        logger.info("File content read successfully", { fileName, contentLength: textContent.length });

        return {
            textContent: `[文件: ${fileName}]\n\n${textContent}`,
            isMultimodal: false,
        };
    } catch (err) {
        logger.error("File download/read failed", { error: err.message, fileName });
        return {
            textContent: `[文件 ${fileName} 下载失败: ${err.message}]`,
            isMultimodal: false,
        };
    }
}

/**
 * 获取文件扩展名（小写，带点）
 */
function getFileExtension(filename) {
    const lastDot = filename.lastIndexOf(".");
    if (lastDot === -1) return "";
    return filename.substring(lastDot).toLowerCase();
}

/**
 * 格式化文件大小
 */
function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return "未知大小";
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
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

        case "file":
            const fileResult = await handleFile(message, config);
            return {
                type: "file",
                content: fileResult.textContent,
                isMultimodal: false,
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
