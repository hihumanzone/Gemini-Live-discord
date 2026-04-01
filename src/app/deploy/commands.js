import { REST, Routes } from 'discord.js';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { config } from '../../config/index.js';
import { COMMANDS } from '../commands.js';

const COMMAND_HASH_PATH = path.join(config.projectRootDir, '.cache', 'discord-commands.sha256');

function computeCommandsHash() {
  return createHash('sha256').update(JSON.stringify(COMMANDS)).digest('hex');
}

async function readPreviousHash() {
  try {
    const previousHash = await fs.readFile(COMMAND_HASH_PATH, 'utf8');
    return previousHash.trim() || null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeCurrentHash(hash) {
  await fs.mkdir(path.dirname(COMMAND_HASH_PATH), { recursive: true });
  await fs.writeFile(COMMAND_HASH_PATH, `${hash}\n`, 'utf8');
}

export async function deployCommandsIfChanged(clientId) {
  try {
    const currentHash = computeCommandsHash();

    let previousHash = null;
    try {
      previousHash = await readPreviousHash();
    } catch (hashReadError) {
      console.warn('[deploy] Failed to read previous command hash; forcing deployment.', hashReadError);
    }

    if (previousHash === currentHash) {
      console.log('[deploy] Command definitions unchanged; skipping application (/) refresh.');
      return { deployed: false, hash: currentHash };
    }

    console.log('[deploy] Command definition changes detected; refreshing application (/) commands.');

    const rest = new REST({ version: '10' }).setToken(config.discordToken);

    await rest.put(
      Routes.applicationCommands(clientId),
      { body: COMMANDS },
    );

    await writeCurrentHash(currentHash);

    console.log('[deploy] Successfully reloaded application (/) commands.');
    return { deployed: true, hash: currentHash };
  } catch (error) {
    console.error('[deploy] Failed to reload application (/) commands', error);
    return { deployed: false, hash: null, error };
  }
}
