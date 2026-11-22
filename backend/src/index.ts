import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { config } from "./config";
import { prisma } from "./db";
import { registerApiRoutes } from "./routes/api";
import { registerMediaRoutes } from "./routes/media";
import { startCronJobs, stopCronJobs } from "./services/cronService";
import { startBot, stopBot } from "./bot";

export const app = Fastify({ logger: true });

async function start(): Promise<void> {
  await app.register(cors, { origin: config.webappUrl });
  await app.register(multipart, {
    limits: { fileSize: 15 * 1024 * 1024 },
  });
  registerMediaRoutes(app);
  registerApiRoutes(app);
  startCronJobs();
  await app.listen({ port: config.port, host: config.host });
  await startBot();
}

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  app.log.info(`Received ${signal}; shutting down`);

  try {
    await stopBot();
  } catch (error) {
    app.log.error(error, "Failed to stop Telegram bot cleanly");
    process.exitCode = 1;
  }
  try {
    await stopCronJobs();
    await app.close();
    await prisma.$disconnect();
  } catch (error) {
    app.log.error(error, "Failed to shut down backend cleanly");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

void start().catch((error: unknown) => {
  app.log.error(error);
  process.exitCode = 1;
});
