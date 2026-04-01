import { VoiceConnectionStatus, entersState } from '@discordjs/voice';

/**
 * @param {{
 *   connection: import('@discordjs/voice').VoiceConnection,
 *   isDestroyed: () => boolean,
 *   onVoiceReadyChanged: (ready: boolean) => void,
 *   onUnrecoverableDisconnect: () => Promise<void>,
 *   log: (scope: string, ...args: any[]) => void,
 * }} deps
 */
export function attachVoiceConnectionLifecycle({
  connection,
  isDestroyed,
  onVoiceReadyChanged,
  onUnrecoverableDisconnect,
  log,
}) {
  const onStateChange = (oldState, newState) => {
    if (oldState.status !== newState.status) {
      log('voice', `State ${oldState.status} -> ${newState.status}`);
    }

    onVoiceReadyChanged(newState.status === VoiceConnectionStatus.Ready);
  };

  const onError = (error) => {
    log('voice', 'Voice connection error', error);
  };

  const onDisconnected = async () => {
    if (isDestroyed()) return;

    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      log('voice', 'Voice connection did not recover after disconnect; destroying bridge');
      await onUnrecoverableDisconnect();
    }
  };

  connection.on('stateChange', onStateChange);
  connection.on('error', onError);
  connection.on(VoiceConnectionStatus.Disconnected, onDisconnected);

  return function detach() {
    connection.off('stateChange', onStateChange);
    connection.off('error', onError);
    connection.off(VoiceConnectionStatus.Disconnected, onDisconnected);
  };
}
