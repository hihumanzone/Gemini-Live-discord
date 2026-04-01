export class ModelAudioGate {
  constructor() {
    this.awaitingServerBargeIn = false;
    this.awaitingServerBargeInSince = 0;
    this.dropModelAudioUntilBargeInAck = false;
  }

  beginAwaitingServerAck() {
    this.awaitingServerBargeIn = true;
    this.awaitingServerBargeInSince = Date.now();
    this.dropModelAudioUntilBargeInAck = true;
  }

  clear() {
    this.awaitingServerBargeIn = false;
    this.awaitingServerBargeInSince = 0;
    this.dropModelAudioUntilBargeInAck = false;
  }

  shouldDropModelAudio() {
    return this.dropModelAudioUntilBargeInAck;
  }

  isAwaitingServerAck() {
    return this.awaitingServerBargeIn;
  }

  maybeReleaseStaleModelAudioGate(fallbackMs) {
    if (!this.awaitingServerBargeIn || !this.awaitingServerBargeInSince) return;

    const elapsedMs = Date.now() - this.awaitingServerBargeInSince;
    if (elapsedMs >= fallbackMs) {
      this.clear();
    }
  }
}
