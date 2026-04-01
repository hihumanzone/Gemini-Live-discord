import { config } from '../config/index.js';

export function logRoutineAction(...args) {
  if (config.suppressRoutineActionLogs) return;
  console.log(...args);
}

export function logImportantEvent(...args) {
  console.log(...args);
}
