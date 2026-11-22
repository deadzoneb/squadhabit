"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.app = void 0;
const cors_1 = __importDefault(require("@fastify/cors"));
const multipart_1 = __importDefault(require("@fastify/multipart"));
const fastify_1 = __importDefault(require("fastify"));
const config_1 = require("./config");
const db_1 = require("./db");
const api_1 = require("./routes/api");
const media_1 = require("./routes/media");
const cronService_1 = require("./services/cronService");
const bot_1 = require("./bot");
exports.app = (0, fastify_1.default)({ logger: true });
async function start() {
    await exports.app.register(cors_1.default, { origin: config_1.config.webappUrl });
    await exports.app.register(multipart_1.default, {
        limits: { fileSize: 15 * 1024 * 1024 },
    });
    (0, media_1.registerMediaRoutes)(exports.app);
    (0, api_1.registerApiRoutes)(exports.app);
    (0, cronService_1.startCronJobs)();
    await exports.app.listen({ port: config_1.config.port, host: config_1.config.host });
    await (0, bot_1.startBot)();
}
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    exports.app.log.info(`Received ${signal}; shutting down`);
    try {
        await (0, bot_1.stopBot)();
    }
    catch (error) {
        exports.app.log.error(error, "Failed to stop Telegram bot cleanly");
        process.exitCode = 1;
    }
    try {
        await (0, cronService_1.stopCronJobs)();
        await exports.app.close();
        await db_1.prisma.$disconnect();
    }
    catch (error) {
        exports.app.log.error(error, "Failed to shut down backend cleanly");
        process.exitCode = 1;
    }
}
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
void start().catch((error) => {
    exports.app.log.error(error);
    process.exitCode = 1;
});
