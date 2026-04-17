#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "httpx>=0.27",
#     "python-dotenv>=1.0",
# ]
# ///
"""
Benchmark TTS Darija — Gemini 3.1 Flash TTS vs ElevenLabs (voix Ghizlane).

Setup (2 options) :
  A. uv (recommandé) : curl -LsSf https://astral.sh/uv/install.sh | sh
     puis           : ./benchmark.py
  B. pip classique    : pip install httpx python-dotenv
                        python benchmark.py

Prérequis :
  - Copie .env.example vers .env et mets les 2 clés
  - Clé Gemini     : https://aistudio.google.com/apikey
  - Clé ElevenLabs : https://elevenlabs.io/app/settings/api-keys

Résultat :
  output/*.wav + output/*.mp3 + output/compare.html  (ouvre le HTML dans ton navigateur)
"""

from __future__ import annotations

import base64
import json
import os
import random
import struct
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

HERE = Path(__file__).parent
OUT = HERE / "output"
PHRASES_FILE = HERE / "phrases.json"

GEMINI_MODEL = "gemini-3.1-flash-tts-preview"
GEMINI_URL = (
    f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"
)
GEMINI_VOICE = "Kore"

ELEVENLABS_VOICE_ID = "OfGMGmhShO8iL9jCkXy8"  # Ghizlane — Moroccan Darija
ELEVENLABS_MODEL = "eleven_flash_v2_5"
ELEVENLABS_URL = f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}"


def pcm_to_wav(pcm: bytes, sample_rate: int = 24000) -> bytes:
    """Gemini TTS retourne du PCM 16-bit mono brut : on l'enveloppe en WAV."""
    num_channels, bits = 1, 16
    byte_rate = sample_rate * num_channels * bits // 8
    block_align = num_channels * bits // 8
    return (
        b"RIFF"
        + struct.pack("<I", 36 + len(pcm))
        + b"WAVE"
        + b"fmt "
        + struct.pack("<IHHIIHH", 16, 1, num_channels, sample_rate, byte_rate, block_align, bits)
        + b"data"
        + struct.pack("<I", len(pcm))
        + pcm
    )


def gemini_tts(text: str, style_prompt: str, api_key: str) -> bytes:
    prompt = f"{style_prompt}: {text}"
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseModalities": ["AUDIO"],
            "speechConfig": {
                "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": GEMINI_VOICE}}
            },
        },
    }
    r = httpx.post(GEMINI_URL, params={"key": api_key}, json=body, timeout=60.0)
    r.raise_for_status()
    data = r.json()
    b64 = data["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
    return pcm_to_wav(base64.b64decode(b64))


def elevenlabs_tts(text: str, api_key: str) -> bytes:
    r = httpx.post(
        ELEVENLABS_URL,
        headers={"xi-api-key": api_key, "Content-Type": "application/json"},
        json={
            "text": text,
            "model_id": ELEVENLABS_MODEL,
            "voice_settings": {
                "stability": 0.5,
                "similarity_boost": 0.75,
                "style": 0.3,
                "use_speaker_boost": True,
            },
        },
        timeout=60.0,
    )
    r.raise_for_status()
    return r.content


def build_html(results: list[dict]) -> str:
    cards: list[str] = []
    for r in results:
        a_src, b_src = r["a_file"], r["b_file"]
        a_label, b_label = r["a_label"], r["b_label"]
        gem_err = r.get("gemini_error")
        el_err = r.get("elevenlabs_error")
        warnings = ""
        if gem_err:
            warnings += f'<div class="warn">Gemini erreur : {gem_err}</div>'
        if el_err:
            warnings += f'<div class="warn">ElevenLabs erreur : {el_err}</div>'
        cards.append(
            f"""
            <article class="card">
              <header>
                <span class="tag">{r["lang"]}</span>
                <h3>{r["scene"]}</h3>
              </header>
              <p class="text">« {r["text"]} »</p>
              {warnings}
              <div class="row">
                <div class="col"><div class="letter">A</div>
                  <audio controls src="{a_src}"></audio>
                  <div class="reveal" data-label="{a_label}">Révéler</div>
                </div>
                <div class="col"><div class="letter">B</div>
                  <audio controls src="{b_src}"></audio>
                  <div class="reveal" data-label="{b_label}">Révéler</div>
                </div>
              </div>
            </article>"""
        )
    return f"""<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>Benchmark TTS Darija — Gemini 3.1 Flash vs ElevenLabs</title>
  <style>
    :root {{ color-scheme: light dark; }}
    body {{ font-family: -apple-system, system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }}
    h1 {{ font-size: 1.5rem; margin-bottom: .25rem; }}
    .lead {{ opacity: .75; margin-top: 0; }}
    .card {{ border: 1px solid #8884; border-radius: 12px; padding: 1rem 1.25rem; margin: 1rem 0; }}
    .card header {{ display: flex; align-items: center; gap: .75rem; }}
    .tag {{ background: #4f46e511; color: #4f46e5; padding: .15rem .5rem; border-radius: 999px; font-size: .75rem; font-weight: 600; text-transform: uppercase; }}
    .text {{ font-size: 1rem; padding: .75rem; background: #8881; border-radius: 8px; margin: .5rem 0 1rem; }}
    .row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }}
    .col {{ border: 1px dashed #8886; border-radius: 8px; padding: .75rem; text-align: center; }}
    .letter {{ font-size: 2rem; font-weight: 700; opacity: .35; }}
    audio {{ width: 100%; margin: .5rem 0; }}
    .reveal {{ cursor: pointer; font-size: .85rem; color: #4f46e5; user-select: none; }}
    .reveal.shown {{ color: inherit; font-weight: 600; }}
    .warn {{ background: #f59e0b22; color: #92400e; padding: .4rem .6rem; border-radius: 6px; font-size: .85rem; margin: .5rem 0; }}
    footer {{ margin: 2rem 0; opacity: .6; font-size: .85rem; }}
  </style>
</head>
<body>
  <h1>Benchmark TTS Darija — blind A/B</h1>
  <p class="lead">Écoute A puis B pour chaque phrase. Note ta préférence mentalement, clique « Révéler » à la fin pour voir le gagnant.</p>
  {''.join(cards)}
  <footer>
    Gemini 3.1 Flash TTS (voix {GEMINI_VOICE} + prompt de style) vs ElevenLabs Multilingual v2 (voix Ghizlane).
    Ordre A/B randomisé par phrase.
  </footer>
  <script>
    document.querySelectorAll('.reveal').forEach(el => {{
      el.addEventListener('click', () => {{
        el.textContent = el.dataset.label;
        el.classList.add('shown');
      }});
    }});
  </script>
</body>
</html>
"""


def main() -> int:
    load_dotenv(HERE / ".env")
    gemini_key = (os.getenv("GEMINI_API_KEY") or "").strip()
    el_key = (os.getenv("ELEVENLABS_API_KEY") or "").strip()
    if not gemini_key or not el_key:
        print("❌ GEMINI_API_KEY et ELEVENLABS_API_KEY requis dans .env", file=sys.stderr)
        return 1

    OUT.mkdir(exist_ok=True)
    phrases = json.loads(PHRASES_FILE.read_text(encoding="utf-8"))

    results: list[dict] = []
    for p in phrases:
        pid = p["id"]
        print(f"→ {pid}  [{p['scene']}]")

        gem_path = OUT / f"gemini_{pid}.wav"
        el_path = OUT / f"elevenlabs_{pid}.mp3"
        gem_err: str | None = None
        el_err: str | None = None

        try:
            gem_path.write_bytes(gemini_tts(p["text"], p["style_prompt"], gemini_key))
            print(f"   ✓ Gemini    → {gem_path.name}")
        except Exception as e:
            gem_err = str(e)[:180]
            print(f"   ✗ Gemini    : {gem_err}")

        try:
            el_path.write_bytes(elevenlabs_tts(p["text"], el_key))
            print(f"   ✓ ElevenLabs → {el_path.name}")
        except Exception as e:
            el_err = str(e)[:180]
            print(f"   ✗ ElevenLabs: {el_err}")

        if random.random() < 0.5:
            a_file, a_label = gem_path.name, "Gemini 3.1 Flash TTS"
            b_file, b_label = el_path.name, "ElevenLabs Ghizlane"
        else:
            a_file, a_label = el_path.name, "ElevenLabs Ghizlane"
            b_file, b_label = gem_path.name, "Gemini 3.1 Flash TTS"

        results.append({
            "id": pid, "scene": p["scene"], "lang": p["lang"], "text": p["text"],
            "a_file": a_file, "a_label": a_label,
            "b_file": b_file, "b_label": b_label,
            "gemini_error": gem_err, "elevenlabs_error": el_err,
        })

    html_path = OUT / "compare.html"
    html_path.write_text(build_html(results), encoding="utf-8")
    print(f"\n✅ Terminé. Ouvre : {html_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
