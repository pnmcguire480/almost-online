'use strict';

// In-memory incident log for the Report button (PARITY.md S5, PROTOCOL.md 5.15).
// Each entry holds exactly two fields: the reported screen name and the time (ISO 8601, UTC).
// It never holds the reporter's name or any message text.

const INCIDENT_MAX = 500;

class IncidentLog {
  constructor() {
    this.entries = [];
  }

  add({ screen_name: screenName, time }) {
    this.entries.push({ screen_name: String(screenName), time: String(time) });
    if (this.entries.length > INCIDENT_MAX) this.entries.shift();
  }

  list() {
    return this.entries.map((entry) => ({ ...entry }));
  }

  get size() {
    return this.entries.length;
  }
}

module.exports = { IncidentLog, INCIDENT_MAX };
