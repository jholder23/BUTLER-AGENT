"""Prompt-activated MIDI clip generator for Ableton.

Examples:
  python scripts/prompt_midi_generator.py --prompt "dark scary melody in A minor, 8 bars, 78 bpm"
  python scripts/prompt_midi_generator.py --prompt "bright major arpeggio in C, 4 bars, 120 bpm" --seed 42

Outputs a Standard MIDI File (.mid) you can drag into Ableton.
"""

from __future__ import annotations

import argparse
import re
import time
from dataclasses import dataclass
from pathlib import Path
from random import Random
from typing import Iterable

from mido import Message, MetaMessage, MidiFile, MidiTrack


def bpm_to_microseconds_per_beat(bpm: float) -> int:
    return int(round(60_000_000 / bpm))


NOTE_TO_PC: dict[str, int] = {
    "C": 0,
    "B#": 0,
    "C#": 1,
    "DB": 1,
    "D": 2,
    "D#": 3,
    "EB": 3,
    "E": 4,
    "FB": 4,
    "E#": 5,
    "F": 5,
    "F#": 6,
    "GB": 6,
    "G": 7,
    "G#": 8,
    "AB": 8,
    "A": 9,
    "A#": 10,
    "BB": 10,
    "B": 11,
    "CB": 11,
}


def parse_key(prompt: str) -> tuple[int, str] | None:
    # Accept "A minor", "Bb major", "F#", "Cmaj", "D min", etc.
    p = prompt.upper()
    p = p.replace("♯", "#").replace("♭", "B")
    m = re.search(r"\b([A-G])\s*([#B])?\s*(MAJ(OR)?|MIN(OR)?)?\b", p)
    if not m:
        return None
    root = m.group(1) + (m.group(2) or "")
    mode_token = m.group(3) or ""
    mode = "minor" if "MIN" in mode_token else ("major" if "MAJ" in mode_token else "minor")
    pc = NOTE_TO_PC.get(root)
    if pc is None:
        return None
    return pc, mode


def parse_bpm(prompt: str) -> float | None:
    m = re.search(r"\b(\d{2,3})\s*bpm\b", prompt, re.IGNORECASE)
    if not m:
        return None
    bpm = float(m.group(1))
    if 30 <= bpm <= 220:
        return bpm
    return None


def parse_bars(prompt: str) -> int | None:
    m = re.search(r"\b(\d{1,3})\s*bars?\b", prompt, re.IGNORECASE)
    if not m:
        return None
    bars = int(m.group(1))
    if 1 <= bars <= 128:
        return bars
    return None


def parse_seed(prompt: str) -> int | None:
    m = re.search(r"\bseed\s*(\d+)\b", prompt, re.IGNORECASE)
    if not m:
        return None
    return int(m.group(1))


def detect_mood(prompt: str) -> str:
    p = prompt.lower()
    dark_words = ("dark", "scary", "horror", "creepy", "evil", "ominous", "tense", "dread", "suspense")
    bright_words = ("bright", "happy", "uplifting", "cheerful", "pop", "sunny")
    if any(w in p for w in dark_words):
        return "dark"
    if any(w in p for w in bright_words):
        return "bright"
    return "neutral"


@dataclass(frozen=True)
class Spec:
    prompt: str
    key_pc: int  # 0..11
    mode: str  # "minor" | "major"
    bpm: float
    bars: int
    mood: str  # "dark" | "bright" | "neutral"
    seed: int


def _prompt_choice(prompt: str, choices: list[str], default: str) -> str:
    ch_low = {c.lower(): c for c in choices}
    d = default.lower()
    if d not in ch_low:
        raise ValueError("Default must be one of choices")
    while True:
        raw = input(f"{prompt} ({'/'.join(choices)}) [{default}]: ").strip()
        if not raw:
            return ch_low[d]
        v = raw.lower()
        if v in ch_low:
            return ch_low[v]
        print(f"Invalid choice: {raw}")


def _prompt_int(prompt: str, default: int, lo: int, hi: int) -> int:
    while True:
        raw = input(f"{prompt} [{default}]: ").strip()
        if not raw:
            return default
        try:
            v = int(raw)
        except ValueError:
            print("Enter a whole number.")
            continue
        if lo <= v <= hi:
            return v
        print(f"Out of range ({lo}-{hi}).")


def _prompt_float(prompt: str, default: float, lo: float, hi: float) -> float:
    while True:
        raw = input(f"{prompt} [{default}]: ").strip()
        if not raw:
            return default
        try:
            v = float(raw)
        except ValueError:
            print("Enter a number.")
            continue
        if lo <= v <= hi:
            return v
        print(f"Out of range ({lo}-{hi}).")


def _prompt_key() -> tuple[int, str]:
    while True:
        raw = input("Key (e.g. A minor, C# major) [A minor]: ").strip()
        if not raw:
            return NOTE_TO_PC["A"], "minor"
        parsed = parse_key(raw)
        if parsed:
            return parsed
        print("Could not parse key. Examples: A minor, Bb major, F# minor.")


def build_spec_interactive() -> Spec:
    bpm = _prompt_float("BPM", default=78.0, lo=30.0, hi=220.0)
    key_pc, mode = _prompt_key()
    mood = _prompt_choice("Mood", ["dark", "neutral", "bright"], default="dark")
    bars = _prompt_int("Bars", default=8, lo=1, hi=128)
    seed = _prompt_int("Seed (for repeatable results)", default=int(time.time()) & 0xFFFFFFFF, lo=0, hi=2**31 - 1)
    prompt = f"{mood} melody in {pc_to_name(key_pc)} {mode}, {bars} bars, {int(round(bpm))} bpm, seed {seed}"
    return Spec(prompt=prompt, key_pc=key_pc, mode=mode, bpm=bpm, bars=bars, mood=mood, seed=seed)


def pc_to_name(pc: int) -> str:
    # Prefer flats for black keys to keep filenames simple.
    names = {0: "C", 1: "Db", 2: "D", 3: "Eb", 4: "E", 5: "F", 6: "Gb", 7: "G", 8: "Ab", 9: "A", 10: "Bb", 11: "B"}
    return names.get(pc % 12, "C")


def scale_pcs(root_pc: int, mode: str, mood: str) -> list[int]:
    # Intervals from root (in semitones).
    if mode == "major":
        intervals = [0, 2, 4, 5, 7, 9, 11]
    else:
        # Natural minor base, with optional harmonic minor leading tone for "dark/tense".
        intervals = [0, 2, 3, 5, 7, 8, 10]
        if mood == "dark":
            intervals = [0, 2, 3, 5, 7, 8, 11]  # harmonic minor (raised 7)
    return [((root_pc + i) % 12) for i in intervals]


def midi_note(pc: int, octave: int) -> int:
    # MIDI note number where C4 = 60, octave 4 => C4.
    return 12 * (octave + 1) + pc


def clamp(n: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, n))


def weighted_choice(rng: Random, items: list[tuple[int, float]]) -> int:
    total = sum(w for _, w in items)
    x = rng.random() * total
    acc = 0.0
    for val, w in items:
        acc += w
        if x <= acc:
            return val
    return items[-1][0]


def generate_melody_notes(spec: Spec) -> list[tuple[int, int, int]]:
    """Return list of (midi_note, duration_ticks, velocity)."""
    ticks = 480
    q = ticks
    e = ticks // 2
    s = ticks // 4
    bar_ticks = q * 4
    total_ticks = bar_ticks * spec.bars

    rng = Random(spec.seed)
    pcs = scale_pcs(spec.key_pc, spec.mode, spec.mood)

    # Register and rhythm density based on mood.
    if spec.mood == "dark":
        base_octave = 2
        rest_prob = 0.22
        step_bias = 0.78
        vel_lo, vel_hi = 62, 98
        rhythm_pool = [e, e, e, q, q, s, s]
    elif spec.mood == "bright":
        base_octave = 4
        rest_prob = 0.10
        step_bias = 0.65
        vel_lo, vel_hi = 70, 110
        rhythm_pool = [s, s, e, e, q, q]
    else:
        base_octave = 3
        rest_prob = 0.16
        step_bias = 0.70
        vel_lo, vel_hi = 66, 104
        rhythm_pool = [s, e, e, q, q]

    # Start on tonic.
    degree = 0
    octave = base_octave
    current_note = midi_note(pcs[degree], octave)

    events: list[tuple[int, int, int]] = []
    t = 0
    while t < total_ticks:
        dur = rng.choice(rhythm_pool)
        dur = min(dur, total_ticks - t)

        if rng.random() < rest_prob:
            events.append((-1, dur, 0))
            t += dur
            continue

        # Movement: mostly steps, sometimes leaps; darker mood prefers descending motion.
        direction_bias = -0.20 if spec.mood == "dark" else 0.05
        direction = -1 if (rng.random() < 0.5 - direction_bias) else 1

        if rng.random() < step_bias:
            step = direction * weighted_choice(rng, [(1, 0.75), (2, 0.25)])
        else:
            step = direction * weighted_choice(rng, [(3, 0.55), (4, 0.30), (5, 0.15)])

        degree = (degree + step) % 7
        target_pc = pcs[degree]

        # Occasionally force a leading-tone -> tonic resolution in dark minor.
        if spec.mood == "dark" and spec.mode == "minor" and rng.random() < 0.12:
            # Set up leading tone then resolve next note.
            leading_pc = (spec.key_pc + 11) % 12
            lead_note = midi_note(leading_pc, clamp(octave + (1 if leading_pc < pcs[0] else 0), 2, 5))
            vel = rng.randint(vel_lo, vel_hi)
            events.append((lead_note, dur, vel))
            t += dur
            if t >= total_ticks:
                break
            dur2 = min(rng.choice([e, q]), total_ticks - t)
            tonic_note = midi_note(spec.key_pc, octave)
            events.append((tonic_note, dur2, clamp(vel + 6, 1, 127)))
            t += dur2
            current_note = tonic_note
            continue

        # Fit to a comfortable range.
        candidate = midi_note(target_pc, octave)
        if candidate - current_note > 8 and rng.random() < 0.7:
            octave = clamp(octave - 1, 1, 6)
        elif current_note - candidate > 8 and rng.random() < 0.7:
            octave = clamp(octave + 1, 1, 6)
        candidate = midi_note(target_pc, octave)

        # Keep within a tight range for darkness.
        lo = midi_note(spec.key_pc, 2 if spec.mood == "dark" else 3)
        hi = midi_note((spec.key_pc + 7) % 12, 4 if spec.mood == "dark" else 5)
        if candidate < lo:
            candidate += 12
        if candidate > hi:
            candidate -= 12

        vel = rng.randint(vel_lo, vel_hi)
        events.append((candidate, dur, vel))
        current_note = candidate
        t += dur

    # End with tonic to make the clip loop-friendly.
    if events:
        final_note = midi_note(spec.key_pc, base_octave)
        events[-1] = (final_note if events[-1][0] != -1 else final_note, events[-1][1], events[-1][2] or 90)
    return events


def events_to_midi(
    *,
    events: Iterable[tuple[int, int, int]],
    bpm: float,
    out_path: Path,
    track_name: str,
    program: int = 0,
) -> None:
    ticks = 480
    mid = MidiFile(ticks_per_beat=ticks)
    tr = MidiTrack()
    mid.tracks.append(tr)

    tr.append(MetaMessage("track_name", name=track_name[:127], time=0))
    tr.append(MetaMessage("set_tempo", tempo=bpm_to_microseconds_per_beat(bpm), time=0))
    tr.append(Message("program_change", program=clamp(program, 0, 127), channel=0, time=0))

    wait = 0
    for note, dur, vel in events:
        if note < 0:
            wait += dur
            continue
        tr.append(Message("note_on", note=note, velocity=clamp(vel, 1, 127), channel=0, time=wait))
        wait = 0
        tr.append(Message("note_off", note=note, velocity=0, channel=0, time=dur))

    tr.append(MetaMessage("end_of_track", time=0))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    mid.save(str(out_path))


def build_spec(prompt: str, seed: int | None, bpm: float | None, bars: int | None) -> Spec:
    key = parse_key(prompt) or (NOTE_TO_PC["A"], "minor")
    key_pc, mode = key
    mood = detect_mood(prompt)
    parsed_seed = parse_seed(prompt)
    final_seed = seed if seed is not None else (parsed_seed if parsed_seed is not None else int(time.time()) & 0xFFFFFFFF)
    final_bpm = bpm if bpm is not None else (parse_bpm(prompt) or (78.0 if mood == "dark" else 110.0))
    final_bars = bars if bars is not None else (parse_bars(prompt) or 8)
    return Spec(prompt=prompt, key_pc=key_pc, mode=mode, bpm=final_bpm, bars=final_bars, mood=mood, seed=final_seed)


def main() -> None:
    p = argparse.ArgumentParser(description="Prompt-activated MIDI melody generator.")
    p.add_argument("--prompt", "-p", type=str, default="", help="Text prompt describing the clip.")
    p.add_argument("--output", "-o", type=Path, default=None, help="Output .mid path.")
    p.add_argument("--seed", type=int, default=None, help="Random seed (overrides prompt seed).")
    p.add_argument("--bpm", type=float, default=None, help="Tempo in BPM (overrides prompt BPM).")
    p.add_argument("--bars", type=int, default=None, help="Number of bars (overrides prompt bars).")
    p.add_argument("--program", type=int, default=0, help="MIDI program number (0-127).")
    args = p.parse_args()

    prompt = args.prompt.strip()
    if prompt:
        spec = build_spec(prompt, seed=args.seed, bpm=args.bpm, bars=args.bars)
    else:
        # Wizard mode: ask BPM/key/mood (requested UX).
        spec = build_spec_interactive()
        # CLI overrides still apply in wizard mode if provided.
        if args.seed is not None:
            spec = Spec(prompt=spec.prompt, key_pc=spec.key_pc, mode=spec.mode, bpm=spec.bpm, bars=spec.bars, mood=spec.mood, seed=args.seed)
        if args.bpm is not None:
            spec = Spec(prompt=spec.prompt, key_pc=spec.key_pc, mode=spec.mode, bpm=args.bpm, bars=spec.bars, mood=spec.mood, seed=spec.seed)
        if args.bars is not None:
            spec = Spec(prompt=spec.prompt, key_pc=spec.key_pc, mode=spec.mode, bpm=spec.bpm, bars=args.bars, mood=spec.mood, seed=spec.seed)

    events = generate_melody_notes(spec)

    safe_stub = re.sub(r"[^a-zA-Z0-9._-]+", "_", spec.prompt.strip())[:64].strip("_") or "midi_clip"
    default_out = Path(__file__).resolve().parents[1] / "exports" / f"{safe_stub}.mid"
    out_path = args.output or default_out

    track_name = f"{spec.mood} {spec.mode} melody (seed {spec.seed})"
    events_to_midi(events=events, bpm=spec.bpm, out_path=out_path, track_name=track_name, program=args.program)

    print(str(out_path))


if __name__ == "__main__":
    main()

