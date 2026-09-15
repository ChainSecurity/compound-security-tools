import pino from "pino";

// Use pino-pretty only in development CLI mode, not in bundled environments
const isDev = process.env.NODE_ENV !== "production";
const isCLI = process.argv[1]?.includes("decoder") || process.argv[1]?.includes("tsx");

export const logger = isDev && isCLI
  ? pino({
      level: process.env.LOG_LEVEL || "info",
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          ignore: "pid,hostname",
        },
      },
    })
  : pino({
      level: process.env.LOG_LEVEL || "info",
    });
