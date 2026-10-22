'use strict';

const ART_INTERVAL_MS = 650;
const ART = Object.freeze(Object.fromEntries(Object.entries({
  skull: {
    title: 'Skull & crossbones',
    lines: [
      '      .-"""-.',
      '     /       \\',
      '     | () () |',
      '     |   ^   |',
      '      \\  -  /',
      '       |||||',
      '   __  |||||  __',
      '   \\ \\       / /',
      '    \\ \\_____/_/',
      '     /_/     \\_\\',
    ],
  },
  finger: {
    title: 'The middle finger',
    lines: [
      '        _',
      '       | |',
      '       | |',
      '     __| |__',
      '    |  | |  |__',
      '    |  | |  |  |',
      '    |          |',
      '     \\        /',
      '      |      |',
      '      |______|',
    ],
  },
  banner: {
    title: "CHAT ROOM '96",
    lines: [
      '+----------------------------+',
      '|       CHAT ROOM \'96        |',
      '|  28.8k / NO CARRIER / :P   |',
      '|   [ scroll like 1996 ]     |',
      '+----------------------------+',
    ],
  },
  divider: {
    title: 'Scroll divider',
    lines: ['-=[ xXx ]=----[ 1996 ]----=[ xXx ]=-'],
  },
}).map(([name, piece]) => [name, Object.freeze({ ...piece, lines: Object.freeze(piece.lines) })])));

class ArtScroller {
  constructor() {
    this.jobs = new Map();
  }

  start(owner, name, publish, finished) {
    if (this.jobs.has(owner)) return false;
    const lines = ART[name].lines;
    const job = { timer: null, line: 0 };
    this.jobs.set(owner, job);
    const tick = () => {
      publish(lines[job.line], { name, line: ++job.line, total: lines.length });
      if (job.line === lines.length) {
        this.jobs.delete(owner);
        finished();
      } else {
        job.timer = setTimeout(tick, ART_INTERVAL_MS);
      }
    };
    tick();
    return true;
  }

  cancel(owner) {
    const job = this.jobs.get(owner);
    if (!job) return false;
    clearTimeout(job.timer);
    this.jobs.delete(owner);
    return true;
  }

  shutdown() {
    for (const owner of this.jobs.keys()) this.cancel(owner);
  }
}

module.exports = { ART, ART_INTERVAL_MS, ArtScroller };
