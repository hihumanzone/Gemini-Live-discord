export class TurnState {
  constructor() {
    this.turnSpeakerIds = new Set();
    this.lastTurnSpeakerIds = new Set();
    this.currentTranscriptionSpeakerIds = new Set();
    this.turnSentAudio = false;
    this.turnMinForwardUntil = 0;
  }

  markAudioSent(speakerIds = []) {
    this.turnSentAudio = true;
    for (const speakerId of speakerIds) {
      this.turnSpeakerIds.add(speakerId);
    }
  }

  extendMinForward(durationMs) {
    this.turnMinForwardUntil = Math.max(this.turnMinForwardUntil, Date.now() + durationMs);
  }

  setTranscriptionContextFromCurrentTurn() {
    this.currentTranscriptionSpeakerIds = new Set(
      this.turnSpeakerIds.size ? this.turnSpeakerIds : this.lastTurnSpeakerIds,
    );
  }

  getSpeakerIdsForLabel() {
    if (this.currentTranscriptionSpeakerIds.size) {
      return [...this.currentTranscriptionSpeakerIds];
    }

    if (this.turnSpeakerIds.size) {
      return [...this.turnSpeakerIds];
    }

    return [...this.lastTurnSpeakerIds];
  }

  completeCurrentTurn() {
    this.lastTurnSpeakerIds = new Set(this.turnSpeakerIds);
    this.currentTranscriptionSpeakerIds = new Set(this.lastTurnSpeakerIds);
    this.turnSpeakerIds.clear();
    this.turnSentAudio = false;
    this.turnMinForwardUntil = 0;
  }

  reset() {
    this.turnSpeakerIds.clear();
    this.lastTurnSpeakerIds.clear();
    this.currentTranscriptionSpeakerIds.clear();
    this.turnSentAudio = false;
    this.turnMinForwardUntil = 0;
  }
}
