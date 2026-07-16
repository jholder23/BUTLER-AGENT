"""Generate MIDI files for music production. Requires: pip install mido"""
from __future__ import annotations

KICK, SNARE, HIHAT, DRUM_CH = 36, 38, 42, 9
BASS_CH = 0
CHORD_CH = 1


def generate_drum_pattern(path: str, bpm: float = 120, bars: int = 4, style: str = "basic") -> dict:
    try:
        import mido
        from mido import Message, MetaMessage, MidiFile, MidiTrack
    except ImportError:
        return {"ok": False, "message": "Install mido: pip install mido", "path": None}

    ticks_per_beat, beat, half, quarter = 480, 480, 240, 120
    mid = MidiFile(ticks_per_beat=ticks_per_beat)
    tr = MidiTrack()
    mid.tracks.append(tr)
    tr.append(MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm), time=0))

    def add_note(note, vel, duration):
        tr.append(Message("note_on", note=note, velocity=vel, time=0, channel=DRUM_CH))
        tr.append(Message("note_off", note=note, velocity=0, time=duration, channel=DRUM_CH))

    if style == "dubstep":
        # Classic dubstep: kick on 1&3, snare on 3, fast hi-hats. Half-time feel.
        for _ in range(bars):
            add_note(KICK, 110, half)
            add_note(HIHAT, 55, quarter)
            add_note(HIHAT, 70, quarter)
            add_note(KICK, 100, half)
            add_note(HIHAT, 55, quarter)
            add_note(HIHAT, 70, quarter)
            add_note(SNARE, 95, half)
            add_note(HIHAT, 60, quarter)
            add_note(HIHAT, 75, quarter)
            add_note(KICK, 110, half)
            add_note(HIHAT, 55, quarter)
            add_note(HIHAT, 70, quarter)
            add_note(KICK, 100, half)
            add_note(HIHAT, 55, quarter)
            add_note(HIHAT, 70, quarter)
            add_note(SNARE, 95, half)
            add_note(HIHAT, 60, quarter)
            add_note(HIHAT, 75, quarter)
    else:
        # Basic pattern
        for _ in range(bars * 4):
            add_note(KICK, 100, half)
            add_note(HIHAT, 70, half)
            add_note(KICK, 100, half)
            add_note(HIHAT, 70, half)
            add_note(SNARE, 90, half)
            add_note(HIHAT, 70, half)
            add_note(KICK, 100, half)
            add_note(HIHAT, 70, half)
            add_note(KICK, 100, half)
            add_note(HIHAT, 70, half)
            add_note(SNARE, 90, half)
            add_note(HIHAT, 70, half)

    try:
        mid.save(path)
        genre = "dubstep" if style == "dubstep" else "basic"
        return {"ok": True, "message": f"Saved {genre} drum pattern to {path}. Drag into Ableton.", "path": path}
    except Exception as e:
        return {"ok": False, "message": str(e), "path": None}


def generate_dubstep_song(path: str, bpm: float = 140, bars: int = 8) -> dict:
    """Generate a full dubstep song MIDI: drums, bass, chords. Multi-track, drag each track into Ableton."""
    try:
        import mido
        from mido import Message, MetaMessage, MidiFile, MidiTrack
    except ImportError:
        return {"ok": False, "message": "Install mido: pip install mido", "path": None}

    ticks = 480
    beat, half, quarter, eighth = 480, 240, 120, 60
    mid = MidiFile(ticks_per_beat=ticks, type=1)
    tempo_track = MidiTrack()
    tempo_track.append(MetaMessage("set_tempo", tempo=mido.bpm2tempo(bpm), time=0))
    mid.tracks.append(tempo_track)

    def add_note(tr, ch, note, vel, duration):
        tr.append(Message("note_on", note=note, velocity=vel, time=0, channel=ch))
        tr.append(Message("note_off", note=note, velocity=0, time=duration, channel=ch))

    def add_chord(tr, ch, notes, vel, duration):
        for n in notes:
            tr.append(Message("note_on", note=n, velocity=vel, time=0, channel=ch))
        for i, n in enumerate(notes):
            tr.append(Message("note_off", note=n, velocity=0, time=duration if i == 0 else 0, channel=ch))

    # Track 0: Drums
    tr_drums = MidiTrack()
    mid.tracks.append(tr_drums)
    for _ in range(bars):
        add_note(tr_drums, DRUM_CH, KICK, 110, half)
        add_note(tr_drums, DRUM_CH, HIHAT, 55, quarter)
        add_note(tr_drums, DRUM_CH, HIHAT, 70, quarter)
        add_note(tr_drums, DRUM_CH, KICK, 100, half)
        add_note(tr_drums, DRUM_CH, HIHAT, 55, quarter)
        add_note(tr_drums, DRUM_CH, HIHAT, 70, quarter)
        add_note(tr_drums, DRUM_CH, SNARE, 95, half)
        add_note(tr_drums, DRUM_CH, HIHAT, 60, quarter)
        add_note(tr_drums, DRUM_CH, HIHAT, 75, quarter)
        add_note(tr_drums, DRUM_CH, KICK, 110, half)
        add_note(tr_drums, DRUM_CH, HIHAT, 55, quarter)
        add_note(tr_drums, DRUM_CH, HIHAT, 70, quarter)
        add_note(tr_drums, DRUM_CH, KICK, 100, half)
        add_note(tr_drums, DRUM_CH, HIHAT, 55, quarter)
        add_note(tr_drums, DRUM_CH, HIHAT, 70, quarter)
        add_note(tr_drums, DRUM_CH, SNARE, 95, half)
        add_note(tr_drums, DRUM_CH, HIHAT, 60, quarter)
        add_note(tr_drums, DRUM_CH, HIHAT, 75, quarter)

    # Track 1: Sub bass (E minor - E1=28, B1=35). Wobble-style rhythm, root-fifth pattern.
    E1, B1 = 28, 35
    tr_bass = MidiTrack()
    mid.tracks.append(tr_bass)
    for bar in range(bars):
        root, fifth = E1, B1
        add_note(tr_bass, BASS_CH, root, 100, half)
        add_note(tr_bass, BASS_CH, fifth, 80, quarter)
        add_note(tr_bass, BASS_CH, root, 90, quarter)
        add_note(tr_bass, BASS_CH, root, 85, half)
        add_note(tr_bass, BASS_CH, fifth, 75, quarter)
        add_note(tr_bass, BASS_CH, root, 85, quarter)
        add_note(tr_bass, BASS_CH, root, 95, half)
        add_note(tr_bass, BASS_CH, fifth, 70, quarter)
        add_note(tr_bass, BASS_CH, root, 80, quarter)
        add_note(tr_bass, BASS_CH, root, 90, half)
        add_note(tr_bass, BASS_CH, fifth, 75, quarter)
        add_note(tr_bass, BASS_CH, root, 85, quarter)

    # Track 2: Chord stabs (Em - E3,G3,B3). Sparse, on the drop.
    E3, G3, B3 = 52, 55, 59
    tr_chords = MidiTrack()
    mid.tracks.append(tr_chords)
    for bar in range(bars):
        add_chord(tr_chords, CHORD_CH, [E3, G3, B3], 65, beat * 2)

    try:
        mid.save(path)
        return {
            "ok": True,
            "message": f"Saved full dubstep song (drums, bass, chords) to {path}. Drag tracks into Ableton, add synths (e.g. Operator for bass, a pad for chords).",
            "path": path,
        }
    except Exception as e:
        return {"ok": False, "message": str(e), "path": None}
