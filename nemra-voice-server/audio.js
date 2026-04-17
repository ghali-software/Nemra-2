// μ-law ↔ PCM16 conversion + linear resampling (8kHz ↔ 16kHz/24kHz).
// Twilio Media Streams envoie/attend du μ-law 8kHz mono.
// Gemini Live attend du PCM16 16kHz mono en entrée, renvoie du PCM16 24kHz mono.

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

function linearToMulaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_CLIP) sample = MULAW_CLIP;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function mulawToLinear(u) {
  u = ~u & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

// μ-law (Buffer) 8kHz → PCM16 (Buffer) 16kHz — upsample 2x par duplication (bon enough, latence réelle prime sur qualité d'interp).
export function mulaw8kToPcm16k(mulawBuf) {
  const out = Buffer.alloc(mulawBuf.length * 4); // 2 samples × 2 bytes
  for (let i = 0; i < mulawBuf.length; i++) {
    const s = mulawToLinear(mulawBuf[i]);
    out.writeInt16LE(s, i * 4);
    out.writeInt16LE(s, i * 4 + 2);
  }
  return out;
}

// PCM16 24kHz → μ-law 8kHz. Downsample par décimation 3→1 avec moyenne.
export function pcm24kToMulaw8k(pcmBuf) {
  const samples24 = pcmBuf.length / 2;
  const samples8 = Math.floor(samples24 / 3);
  const out = Buffer.alloc(samples8);
  for (let i = 0; i < samples8; i++) {
    const a = pcmBuf.readInt16LE(i * 6);
    const b = pcmBuf.readInt16LE(i * 6 + 2);
    const c = pcmBuf.readInt16LE(i * 6 + 4);
    const avg = Math.round((a + b + c) / 3);
    out[i] = linearToMulaw(avg);
  }
  return out;
}
