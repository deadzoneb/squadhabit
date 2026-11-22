"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMediaRoutes = registerMediaRoutes;
const node_stream_1 = require("node:stream");
const telegram_1 = require("../telegram");
const config_1 = require("../config");
const db_1 = require("../db");
const appError_1 = require("../utils/appError");
const fileIdPattern = /^[A-Za-z0-9_-]{1,512}$/;
const mediaTypesByExtension = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    mp4: "video/mp4",
    ogg: "audio/ogg",
};
function getContentType(filePath, mediaType) {
    const extension = filePath.split(".").pop()?.toLowerCase();
    if (extension && mediaTypesByExtension[extension]) {
        return mediaTypesByExtension[extension];
    }
    if (mediaType === "VIDEO_NOTE") {
        return "video/mp4";
    }
    if (mediaType === "PHOTO") {
        return "image/jpeg";
    }
    return "application/octet-stream";
}
async function* streamChunks(body) {
    const reader = body.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                return;
            }
            yield value;
        }
    }
    finally {
        reader.releaseLock();
    }
}
function registerMediaRoutes(app) {
    app.get("/api/media/:fileId", async (request, reply) => {
        const { fileId } = request.params;
        if (!fileIdPattern.test(fileId)) {
            throw new appError_1.AppError(400, "Invalid media file id");
        }
        const checkin = await db_1.db.checkin.findFirst({
            where: { telegramFileId: fileId },
            select: { mediaType: true },
        });
        if (!checkin) {
            throw new appError_1.AppError(404, "Media not found");
        }
        if (!config_1.config.botToken && config_1.config.devMode) {
            const preview = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#eef2ff"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#475569">SquadHabit preview</text></svg>';
            return reply
                .header("Cache-Control", "private, max-age=3600")
                .type("image/svg+xml")
                .send(preview);
        }
        if (!telegram_1.bot || !config_1.config.botToken) {
            throw new appError_1.AppError(503, "Telegram media storage is not configured");
        }
        const telegramFile = await telegram_1.bot.api.getFile(fileId);
        if (!telegramFile.file_path) {
            throw new appError_1.AppError(502, "Telegram did not return a media path");
        }
        const telegramUrl = `https://api.telegram.org/file/bot${config_1.config.botToken}/${telegramFile.file_path}`;
        const response = await fetch(telegramUrl);
        if (!response.ok || !response.body) {
            throw new appError_1.AppError(502, `Telegram media download failed with status ${response.status}`);
        }
        return reply
            .header("Cache-Control", "private, max-age=3600")
            .type(getContentType(telegramFile.file_path, checkin.mediaType))
            .send(node_stream_1.Readable.from(streamChunks(response.body)));
    });
}
