import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { bot } from "../telegram";
import { config } from "../config";
import { db } from "../db";
import { AppError } from "../utils/appError";

const fileIdPattern = /^[A-Za-z0-9_-]{1,512}$/;

const mediaTypesByExtension: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogg: "audio/ogg",
};

function getContentType(filePath: string, mediaType: string): string {
  const extension = filePath.split(".").pop()?.toLowerCase();
  if (extension && mediaTypesByExtension[extension]) {
    return mediaTypesByExtension[extension];
  }
  if (mediaType === "VIDEO_NOTE") {
    return "video/mp4";
  }
  if (mediaType === "VIDEO") {
    return "video/mp4";
  }
  if (mediaType === "PHOTO") {
    return "image/jpeg";
  }
  return "application/octet-stream";
}

async function* streamChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

export function registerMediaRoutes(app: FastifyInstance): void {
  app.get<{ Params: { fileId: string } }>("/api/media/:fileId", async (request, reply) => {
    const { fileId } = request.params;
    if (!fileIdPattern.test(fileId)) {
      throw new AppError(400, "Invalid media file id");
    }

    const checkin = await db.checkin.findFirst({
      where: { telegramFileId: fileId },
      select: { mediaType: true },
    });
    if (!checkin) {
      throw new AppError(404, "Media not found");
    }

    if (!config.botToken && config.devMode) {
      const preview =
        '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360"><rect width="640" height="360" fill="#eef2ff"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="sans-serif" font-size="24" fill="#475569">SquadHabit preview</text></svg>';
      return reply
        .header("Cache-Control", "private, max-age=3600")
        .type("image/svg+xml")
        .send(preview);
    }

    if (!bot || !config.botToken) {
      throw new AppError(503, "Telegram media storage is not configured");
    }

    const telegramFile = await bot.api.getFile(fileId);
    if (!telegramFile.file_path) {
      throw new AppError(502, "Telegram did not return a media path");
    }

    const telegramUrl = `https://api.telegram.org/file/bot${config.botToken}/${telegramFile.file_path}`;
    const response = await fetch(telegramUrl);
    if (!response.ok || !response.body) {
      throw new AppError(502, `Telegram media download failed with status ${response.status}`);
    }

    const contentLength = response.headers.get("content-length");
    const mediaReply = reply
      .header("Cache-Control", "private, max-age=3600")
      .type(getContentType(telegramFile.file_path, checkin.mediaType));
    if (contentLength) {
      mediaReply.header("Content-Length", contentLength);
    }
    return mediaReply.send(Readable.from(streamChunks(response.body)));
  });
}
