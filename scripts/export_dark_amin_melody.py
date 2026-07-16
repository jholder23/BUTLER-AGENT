"""One-shot: write a dark A minor melody as a .mid for Ableton."""
from __future__ import annotations

import argparse
from pathlib import Path

import mido
from mido import Message, MetaMessage, MidiFile, MidiTrack


def bpm_to_microseconds_per_beat(bpm: float) -> int:
    return int(round(60_000_000 / bpm))


def write_dark_amin_melody(out_path: Path, bpm: float = 78) -> None:
    # Ticks per quarter — common default; Ableton handles this fine.
    ticks = 480
    q = ticks
    e = ticks // 2
    dq = q + e  # dotted quarter
    h = q * 2
    dh = q + q + q  # dotted half (3 beats)

    mid = MidiFile(ticks_per_beat=ticks)
    tr = MidiTrack()
    mid.tracks.append(tr)

    tr.append(MetaMessage("track_name", name="Dark A minor melody", time=0))
    tr.append(MetaMessage("set_tempo", tempo=bpm_to_microseconds_per_beat(bpm), time=0))
    tr.append(Message("program_change", program=0, channel=0, time=0))

    # A2–G4 range (dark). Natural A minor + G# (harmonic minor leading tone).
    # MIDI: A2=45 ... A3=57 ... A4=69
    A2, B2, C3, D3, E3, F3, G3, Gs3 = 45, 47, 48, 50, 52, 53, 55, 56
    A3, B3, C4, D4, E4, F4, G4 = 57, 59, 60, 62, 64, 65, 67

    wait = 0

    def note(n: int, dur: int, vel: int = 86) -> None:
        nonlocal wait
        tr.append(Message("note_on", note=n, velocity=vel, channel=0, time=wait))
        wait = 0
        tr.append(Message("note_off", note=n, velocity=0, channel=0, time=dur))

    def rest(dur: int) -> None:
        nonlocal wait
        wait += dur

    # 8 bars of 4/4 — sparse, descending bias, harmonic minor color, uneasy rhythm.
    # Bar 1
    note(A2, q, 88)
    rest(e)
    note(C3, e, 84)
    note(E3, h, 90)
    # Bar 2
    note(D3, dq, 88)
    note(C3, e, 82)
    note(B2, h, 80)
    # Bar 3 — raised leading tone, hold on tonic (4 beats)
    note(A2, dq, 90)
    note(Gs3, e, 78)
    note(A3, h, 92)
    # Bar 4
    note(B3, q, 85)
    note(C4, q, 82)
    note(D4, h, 88)
    # Bar 5
    note(E4, e, 90)
    note(D4, e, 84)
    note(C4, q, 86)
    note(A3, h, 88)
    # Bar 6
    note(F4, q, 82)
    note(E4, e, 80)
    note(D4, e, 78)
    note(C4, h, 84)
    # Bar 7
    rest(q)
    note(G3, e, 76)
    note(F3, e, 80)
    note(E3, q, 84)
    note(D3, q, 82)
    # Bar 8 — pick-up into dotted-half tonic
    note(C3, e, 78)
    note(B2, e, 76)
    note(A2, dh, 88)

    tr.append(MetaMessage("end_of_track", time=0))
    mid.save(str(out_path))


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument(
        "-o",
        "--output",
        type=Path,
        default=Path(__file__).resolve().parents[1] / "exports" / "dark_scary_amin_melody.mid",
    )
    p.add_argument("--bpm", type=float, default=78.0)
    args = p.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    write_dark_amin_melody(args.output, bpm=args.bpm)
    print(args.output)


if __name__ == "__main__":
    main()
