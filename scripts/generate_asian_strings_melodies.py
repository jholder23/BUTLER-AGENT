"""Generate five 8-bar Asian-inspired pentatonic melodies (MIDI), strictly in time.

- Tempo is explicit in the file (set_tempo); default 84 BPM (not 140).
- 4/4, grid-quantized: each bar is exactly 4 beats; events use only eighth / quarter / half
  lengths that are multiples of the sixteenth-note tick (120 @ PPQ 480).
- GM program 45 (Pizzicato Strings): plucked string bed — swap to guqin/koto in Ableton.

Run:
  python scripts/generate_asian_strings_melodies.py
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from random import Random

from mido import Message, MetaMessage, MidiFile, MidiTrack

TICKS = 480  # PPQ
Q = TICKS  # quarter note = 1 beat
E = TICKS // 2  # eighth
S = TICKS // 4  # sixteenth
BAR = Q * 4  # 4/4 one bar
GRID = S  # quantize to 16th (120 ticks)


def bpm_to_microseconds_per_beat(bpm: float) -> int:
    return int(round(60_000_000 / bpm))


def pc_name(pc: int) -> str:
    return ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"][pc % 12]


def pentatonic_intervals(kind: str) -> list[int]:
    if kind == "major":
        return [0, 2, 4, 7, 9]
    if kind == "minor":
        return [0, 3, 5, 7, 10]
    raise ValueError(kind)


def scale_pcs(root_pc: int, kind: str) -> list[int]:
    return [(root_pc + i) % 12 for i in pentatonic_intervals(kind)]


def midi_in_octave(pc: int, octave: int) -> int:
    return 12 * (octave + 1) + (pc % 12)


def clamp(n: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, n))


def _quantize_dur(ticks: int) -> int:
    """Snap duration down to grid; minimum one 16th."""
    g = max(GRID, (ticks // GRID) * GRID)
    return g if g > 0 else GRID


@dataclass(frozen=True)
class Piece:
    label: str
    root_pc: int
    pent_kind: str
    seed: int


def generate_melody(piece: Piece, bars: int = 8) -> list[tuple[int, int, int]]:
    """
    Strict 4/4: fill `bars` bars with events whose durations sum to bars * BAR exactly.
    Returns (midi_note | -1 for rest, duration_ticks, velocity).
    """
    rng = Random(piece.seed)
    pcs = scale_pcs(piece.root_pc, piece.pent_kind)
    base_oct = 4 if piece.pent_kind == "major" else 3
    degree = 0
    octave = base_oct
    cur = midi_in_octave(pcs[degree], octave)

    # Allowed note lengths (all multiples of GRID): 16th, 8th, quarter, dotted quarter, half.
    lens = [S, E, Q, Q + E, Q * 2]

    out: list[tuple[int, int, int]] = []

    for _bar in range(bars):
        pos = 0  # ticks within bar [0, BAR)
        while pos < BAR:
            room = BAR - pos
            choices = [d for d in lens if d <= room]
            if not choices:
                dur = _quantize_dur(room)
                if dur < GRID:
                    dur = GRID
                out.append((-1, dur, 0))
                pos += dur
                continue
            dur = rng.choice(choices)
            dur = _quantize_dur(dur)
            dur = min(dur, room)

            if rng.random() < 0.14:
                out.append((-1, dur, 0))
                pos += dur
                continue

            step = rng.choice([-2, -1, -1, 0, 1, 1, 2])
            degree = (degree + step) % 5
            target_pc = pcs[degree]
            cand = midi_in_octave(target_pc, octave)

            if cand - cur > 12:
                octave = clamp(octave - 1, 2, 5)
            elif cur - cand > 12:
                octave = clamp(octave + 1, 2, 5)
            cand = midi_in_octave(target_pc, octave)

            lo = midi_in_octave(piece.root_pc, 3)
            hi = midi_in_octave(piece.root_pc, 5) + 12  # two octaves above root
            while cand < lo:
                cand += 12
            while cand > hi:
                cand -= 12

            vel = rng.randint(74, 100)
            out.append((cand, dur, vel))
            cur = cand
            pos += dur

        assert pos == BAR, f"bar length mismatch: {pos} != {BAR}"

    # Last event: end on root (audible resolution), same duration grid
    root_note = midi_in_octave(piece.root_pc, base_oct)
    if out:
        n, d, v = out[-1]
        d = _quantize_dur(d)
        out[-1] = (root_note, d, max(v, 80))

    total = sum(d for _, d, _ in out)
    assert total == bars * BAR, f"total ticks {total} != {bars * BAR}"

    return out


def write_mid(
    path: Path,
    *,
    piece: Piece,
    events: list[tuple[int, int, int]],
    bpm: float,
    program: int = 45,
) -> None:
    mid = MidiFile(ticks_per_beat=TICKS)
    tr = MidiTrack()
    mid.tracks.append(tr)

    name = f"{piece.label} | {int(round(bpm))}bpm | pizz GM{program}"
    tr.append(MetaMessage("track_name", name=name[:127], time=0))
    tr.append(MetaMessage("set_tempo", tempo=bpm_to_microseconds_per_beat(bpm), time=0))
    tr.append(MetaMessage("time_signature", numerator=4, denominator=4, clocks_per_click=24, notated_32nd_notes_per_beat=8, time=0))
    tr.append(Message("program_change", program=clamp(program, 0, 127), channel=0, time=0))

    wait = 0
    for note, dur, vel in events:
        dur = _quantize_dur(dur)
        if note < 0:
            wait += dur
            continue
        tr.append(Message("note_on", note=note, velocity=clamp(vel, 1, 127), channel=0, time=wait))
        wait = 0
        tr.append(Message("note_off", note=note, velocity=0, channel=0, time=dur))
    tr.append(MetaMessage("end_of_track", time=0))
    path.parent.mkdir(parents=True, exist_ok=True)
    mid.save(str(path))


def main() -> None:
    out_dir = Path(__file__).resolve().parents[1] / "exports" / "asian_strings_8bar"
    out_dir.mkdir(parents=True, exist_ok=True)
    # Explicit moderate tempo — avoids clips feeling like ~140 when mis-read.
    bpm = 84.0

    pieces = [
        Piece("D major pentatonic", 2, "major", 91001),
        Piece("G major pentatonic", 7, "major", 91002),
        Piece("A minor pentatonic", 9, "minor", 91003),
        Piece("E major pentatonic", 4, "major", 91004),
        Piece("Bb major pentatonic", 10, "major", 91005),
    ]

    print(f"Generated (8 bars each, strict 4/4 grid, {int(bpm)} BPM in file, GM45 Pizzicato Strings):\n")
    for piece in pieces:
        events = generate_melody(piece, bars=8)
        safe = piece.label.replace(" ", "_").lower()
        path = out_dir / f"melody_{safe}.mid"
        write_mid(path, piece=piece, events=events, bpm=bpm)
        print(f"  {path}")
        print(f"    Key: {piece.label}  (root {pc_name(piece.root_pc)}; seed {piece.seed})\n")


if __name__ == "__main__":
    main()
