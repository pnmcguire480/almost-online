'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const dir = path.resolve(process.env.DEMO_OUTPUT_DIR || 'artifacts/demo');
const { duration, chapters } = JSON.parse(fs.readFileSync(path.join(dir, 'chapters.json')));
const rate = 22050;
const samples = Math.ceil(duration * rate);
const wav = Buffer.alloc(44 + samples * 2);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 2, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) {
  const t = i / rate;
  let value = 0;
  if (t < 2.4) {
    const phase = t % .6;
    const frequency = [440, 660, 880, 1200][Math.floor(t / .6)];
    value = Math.sin(2 * Math.PI * frequency * t) * Math.exp(-phase * 10) * .12;
  }
  for (const chapter of chapters.slice(1)) {
    const elapsed = t - chapter.start;
    if (elapsed >= 0 && elapsed < .15) value += Math.sin(2 * Math.PI * 880 * elapsed) * Math.exp(-elapsed * 32) * .09;
  }
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2);
}
fs.writeFileSync(path.join(dir, 'original-tones.wav'), wav);
execFileSync(process.env.FFMPEG || 'ffmpeg', [
  '-hide_banner', '-loglevel', 'warning', '-y',
  '-i', 'almost-online-demo.webm', '-i', 'original-tones.wav',
  '-vf', "subtitles=captions.srt:force_style='FontName=Arial,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00202020,BorderStyle=3,Outline=8,MarginV=24'",
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-shortest', 'almost-online-demo.mp4',
], { cwd: dir, stdio: 'inherit', windowsHide: true });
console.log(path.join(dir, 'almost-online-demo.mp4'));
