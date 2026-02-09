#!/usr/bin/env node
/**
 * Azure Speech STT 测试脚本
 *
 * 用法:
 *   node scripts/test-azure-stt.js                     # 用静音 WAV 测试 API 连通性
 *   node scripts/test-azure-stt.js path/to/audio.amr   # 转录 AMR 文件（需要 ffmpeg）
 *   node scripts/test-azure-stt.js path/to/audio.wav   # 直接转录 WAV 文件
 *   node scripts/test-azure-stt.js path/to/audio.mp3   # 转录 MP3 文件（需要 ffmpeg）
 *
 * 环境变量 (从项目根目录 .env 文件读取):
 *   AZURE_SPEECH_KEY    - Azure Speech 密钥
 *   AZURE_SPEECH_REGION - Azure Speech 区域 (如 eastasia)
 *   AZURE_SPEECH_LANG   - 识别语言 (默认 zh-CN)
 */

import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, "..");

// ============================================================================
// 加载 .env
// ============================================================================
async function loadEnv() {
    const envPath = join(projectRoot, ".env");
    if (!existsSync(envPath)) {
        console.error("❌ 未找到 .env 文件");
        console.error("   请复制 .env.example 为 .env 并填写 Azure Speech 密钥:");
        console.error("   cp .env.example .env");
        process.exit(1);
    }

    const content = await readFile(envPath, "utf-8");
    for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
            const key = trimmed.slice(0, eqIdx).trim();
            const value = trimmed.slice(eqIdx + 1).trim();
            if (!process.env[key]) {
                process.env[key] = value;
            }
        }
    }
}

// ============================================================================
// 生成静音 WAV (用于测试 API 连通性)
// ============================================================================
function createSilentWav(durationSeconds = 1, sampleRate = 16000) {
    const numChannels = 1;
    const bitsPerSample = 16;
    const bytesPerSample = bitsPerSample / 8;
    const numSamples = sampleRate * durationSeconds;
    const dataSize = numSamples * numChannels * bytesPerSample;
    const headerSize = 44;
    const buffer = Buffer.alloc(headerSize + dataSize);

    // RIFF header
    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataSize, 4);
    buffer.write("WAVE", 8);

    // fmt chunk
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);                                    // PCM
    buffer.writeUInt16LE(numChannels, 22);
    buffer.writeUInt32LE(sampleRate, 24);
    buffer.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
    buffer.writeUInt16LE(numChannels * bytesPerSample, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataSize, 40);
    // 数据全为 0 (静音) — Buffer.alloc 已初始化

    return buffer;
}

// ============================================================================
// 音频转 WAV (通过 ffmpeg)
// ============================================================================
async function convertToWav(inputPath) {
    const ext = extname(inputPath).toLowerCase();

    // WAV 文件直接读取（不需要 ffmpeg）
    if (ext === ".wav") {
        console.log("📄 WAV 文件，直接读取...");
        return await readFile(inputPath);
    }

    // 非 WAV 文件需要 ffmpeg 转换
    console.log(`🔄 转换 ${ext} → WAV (通过 ffmpeg)...`);
    const tmpOut = join(tmpdir(), `stt_test_${Date.now()}.wav`);
    try {
        await execFileAsync("ffmpeg", [
            "-y", "-i", inputPath,
            "-f", "wav", "-ar", "16000", "-ac", "1", "-acodec", "pcm_s16le",
            tmpOut,
        ], { timeout: 30000 });
        const buf = await readFile(tmpOut);
        console.log(`✅ 转换完成: ${buf.length} bytes`);
        return buf;
    } catch (err) {
        if (err.code === "ENOENT") {
            console.error("❌ ffmpeg 未安装。非 WAV 格式文件需要 ffmpeg 转换:");
            console.error("   Linux:  apt install ffmpeg");
            console.error("   macOS:  brew install ffmpeg");
            console.error("   Windows: winget install ffmpeg");
            process.exit(1);
        }
        throw err;
    } finally {
        await unlink(tmpOut).catch(() => {});
    }
}

// ============================================================================
// 调用 Azure STT
// ============================================================================
async function callAzureStt(wavBuffer, config) {
    const { key, region, lang } = config;

    const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${lang}&format=detailed`;

    console.log(`🎙️ 调用 Azure STT...`);
    console.log(`   区域: ${region}`);
    console.log(`   语言: ${lang}`);
    console.log(`   音频大小: ${wavBuffer.length} bytes`);

    const startTime = Date.now();

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Ocp-Apim-Subscription-Key": key,
            "Content-Type": "audio/wav; codecs=audio/pcm; samplerate=16000",
            "Accept": "application/json",
        },
        body: wavBuffer,
        signal: AbortSignal.timeout(30000),
    });

    const elapsed = Date.now() - startTime;

    if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        console.error(`❌ Azure STT 返回 HTTP ${response.status}`);
        console.error(`   响应: ${errorText.substring(0, 500)}`);
        process.exit(1);
    }

    const data = await response.json();
    console.log(`⏱️ 耗时: ${elapsed}ms`);

    return data;
}

// ============================================================================
// 主流程
// ============================================================================
async function main() {
    await loadEnv();

    const key = process.env.AZURE_SPEECH_KEY;
    const region = process.env.AZURE_SPEECH_REGION || "eastasia";
    const lang = process.env.AZURE_SPEECH_LANG || "zh-CN";

    if (!key) {
        console.error("❌ 缺少 AZURE_SPEECH_KEY 环境变量");
        console.error("   请在 .env 文件中设置 AZURE_SPEECH_KEY");
        process.exit(1);
    }

    console.log("========================================");
    console.log("  Azure Speech STT 测试");
    console.log("========================================\n");

    const audioFile = process.argv[2];
    let wavBuffer;

    if (audioFile) {
        // 使用用户提供的音频文件
        if (!existsSync(audioFile)) {
            console.error(`❌ 文件不存在: ${audioFile}`);
            process.exit(1);
        }

        const ext = extname(audioFile).toLowerCase();
        console.log(`📁 输入文件: ${audioFile} (${ext})`);

        if (ext === ".wav") {
            // 可能需要重采样
            wavBuffer = await convertToWav(audioFile);
        } else {
            // 需要 ffmpeg 转换
            wavBuffer = await convertToWav(audioFile);
        }
    } else {
        // 没有提供文件，使用静音 WAV 测试连通性
        console.log("📝 未指定音频文件，使用 1 秒静音测试 API 连通性...");
        console.log("   (提示: 传入音频文件测试实际转录效果)");
        console.log(`   用法: node scripts/test-azure-stt.js <音频文件路径>\n`);
        wavBuffer = createSilentWav(1);
    }

    // 调用 Azure STT
    const result = await callAzureStt(wavBuffer, { key, region, lang });

    // 输出结果
    console.log("\n========== 识别结果 ==========");
    console.log(`状态: ${result.RecognitionStatus}`);

    if (result.RecognitionStatus === "Success") {
        console.log(`✅ 识别文本: ${result.DisplayText}`);
        if (result.NBest && result.NBest.length > 0) {
            console.log(`   置信度: ${(result.NBest[0].Confidence * 100).toFixed(1)}%`);
            if (result.NBest.length > 1) {
                console.log("   候选项:");
                result.NBest.forEach((item, i) => {
                    console.log(`     ${i + 1}. [${(item.Confidence * 100).toFixed(1)}%] ${item.Display}`);
                });
            }
        }
    } else if (result.RecognitionStatus === "NoMatch" || result.RecognitionStatus === "InitialSilenceTimeout") {
        if (audioFile) {
            console.log("⚠️ 未识别到语音内容");
        } else {
            console.log("✅ API 连通性正常！（静音测试预期返回 NoMatch）");
        }
    } else {
        console.log(`⚠️ 非预期状态: ${result.RecognitionStatus}`);
    }

    console.log("\n========== 完整返回 ==========");
    console.log(JSON.stringify(result, null, 2));

    console.log("\n✅ 测试完成！");
}

main().catch((err) => {
    console.error(`\n❌ 测试失败: ${err.message}`);
    process.exit(1);
});
