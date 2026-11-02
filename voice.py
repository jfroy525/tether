"""
Voice input on this Mac: record while the key is held (or between two clicks of the mic), then transcribe
with faster-whisper. Audio never leaves the machine and nothing is kept.
"""

from __future__ import annotations

import threading
import time
from typing import Callable

import numpy as np

RATE = 16000


class Dictation:
    def __init__(self, on_level: Callable[[float], None]):
        self.on_level = on_level
        self._model = None
        self._model_name = ""
        self._stream = None
        self._chunks: list[np.ndarray] = []
        self._lock = threading.Lock()
        self.recording = False

    def warm(self, model: str) -> None:
        """Load the speech model ahead of the first use (takes a second or two)."""
        threading.Thread(target=self._get_model, args=(model,), daemon=True).start()

    def _get_model(self, model: str):
        with self._lock:
            if self._model is None or self._model_name != model:
                from faster_whisper import WhisperModel
                self._model = WhisperModel(model, device="cpu", compute_type="int8")
                self._model_name = model
            return self._model

    def start(self, device: str = "") -> None:
        import sounddevice as sd
        if self.recording:
            return
        self._chunks = []
        last = [0.0]

        def callback(indata, _frames, _time, _status):
            block = indata[:, 0].copy()
            self._chunks.append(block)
            now = time.time()
            if now - last[0] > 0.06:
                last[0] = now
                self.on_level(float(np.sqrt(np.mean(block ** 2))))

        dev = None
        if device:
            dev = next((i for i, d in enumerate(sd.query_devices())
                        if d["max_input_channels"] > 0 and device.lower() in d["name"].lower()), None)
        self._stream = sd.InputStream(samplerate=RATE, channels=1, dtype="float32", callback=callback, device=dev)
        self._stream.start()
        self.recording = True

    def stop(self, model: str, vocabulary: str = "") -> str:
        """Stop recording and return the text ('' if nothing was said)."""
        if not self.recording:
            return ""
        self.recording = False
        try:
            self._stream.stop()
            self._stream.close()
        except Exception:  # noqa: BLE001
            pass
        audio = np.concatenate(self._chunks) if self._chunks else np.zeros(0, dtype=np.float32)
        self._chunks = []
        if len(audio) < RATE * 0.3:
            return ""
        peak = float(np.max(np.abs(audio))) or 1.0
        if peak < 0.004:  # silence
            return ""
        audio = audio * min(20.0, 0.9 / peak)  # quiet USB mics: bring it up before Whisper
        segments, _ = self._get_model(model).transcribe(
            audio, language="en", beam_size=5, vad_filter=True,
            initial_prompt=("Words you may hear: " + vocabulary) if vocabulary.strip() else None)
        return " ".join(s.text.strip() for s in segments).strip()


def input_devices() -> list[str]:
    try:
        import sounddevice as sd
        return [d["name"] for d in sd.query_devices() if d["max_input_channels"] > 0]
    except Exception:  # noqa: BLE001
        return []
