import { createJoinCommandHandler } from '../commands/join.js';
import { createLeaveCommandHandler } from '../commands/leave.js';
import { createResetCommandHandler } from '../commands/reset.js';
import { createCommandRouter } from '../commands/router.js';
import { registerDiscordEvents } from './events/register-discord-events.js';
import { registerProcessHandlers } from './lifecycle/process-handlers.js';
import { createShutdownController } from './lifecycle/shutdown-controller.js';

/**
 * Registers Discord command/event handlers and owns per-guild bridge sessions.
 *
 * @param {{
 *   client: import('discord.js').Client,
 *   config: import('../config/index.js').config,
 *   BridgeClass: typeof import('../services/bridge/discord-gemini-voice-bridge.js').DiscordGeminiVoiceBridge,
 *   logFatal: (error: Error, context?: Record<string, unknown>) => void,
 * }} options
 */
export function registerDiscordBotHandlers({ client, config, BridgeClass, logFatal }) {
  /** @type {Map<string, import('../services/bridge/discord-gemini-voice-bridge.js').DiscordGeminiVoiceBridge>} */
  const sessions = new Map();

  const { stopGuildSession, gracefulShutdown } = createShutdownController({
    client,
    sessions,
    hardTimeoutMs: 10_000,
  });

  const handleJoinCommand = createJoinCommandHandler({
    client,
    BridgeClass,
    sessions,
    stopGuildSession,
  });

  const handleLeaveCommand = createLeaveCommandHandler({
    sessions,
    stopGuildSession,
  });

  const handleResetCommand = createResetCommandHandler({ sessions });

  const routeCommand = createCommandRouter({
    handleJoinCommand,
    handleLeaveCommand,
    handleResetCommand,
  });

  registerProcessHandlers({ gracefulShutdown, logFatal });

  registerDiscordEvents({
    client,
    config,
    sessions,
    routeCommand,
    stopGuildSession,
  });

  return {
    gracefulShutdown,
    sessions,
  };
}
