"""
Ableton Live integration for Butlor.
Requires: pip install pylive
Requires: Ableton Live 11+ with AbletonOSC installed as Control Surface.
"""
from __future__ import annotations

import os


def _try_ableton():
    try:
        import live
    except ImportError:
        return None, "Install pylive: pip install pylive"
    try:
        s = live.Set(scan=True)
        return s, None
    except Exception as e:
        return None, f"Could not connect to Ableton. Is Live 11+ open with AbletonOSC enabled? {e}"


def ableton_set_tempo(bpm: float) -> dict:
    try:
        bpm = float(bpm)
        if bpm < 20 or bpm > 999:
            return {"ok": False, "message": "Tempo must be between 20 and 999 BPM", "data": None}
    except (TypeError, ValueError):
        return {"ok": False, "message": "Invalid tempo value", "data": None}
    set_obj, err = _try_ableton()
    if err:
        return {"ok": False, "message": err, "data": None}
    try:
        set_obj.tempo = bpm
        return {"ok": True, "message": f"Tempo set to {bpm} BPM", "data": {"tempo": bpm}}
    except Exception as e:
        return {"ok": False, "message": str(e), "data": None}


def ableton_status() -> dict:
    set_obj, err = _try_ableton()
    if err:
        return {"ok": False, "message": err, "data": None}
    try:
        tempo = set_obj.tempo
        n_tracks = len(set_obj.tracks)
        return {"ok": True, "message": f"Connected. Tempo: {tempo} BPM, {n_tracks} tracks", "data": {"tempo": tempo, "tracks": n_tracks}}
    except Exception as e:
        return {"ok": False, "message": str(e), "data": None}


def ableton_play() -> dict:
    set_obj, err = _try_ableton()
    if err:
        return {"ok": False, "message": err, "data": None}
    try:
        set_obj.play()
        return {"ok": True, "message": "Playback started", "data": None}
    except Exception as e:
        return {"ok": False, "message": str(e), "data": None}


def ableton_stop() -> dict:
    set_obj, err = _try_ableton()
    if err:
        return {"ok": False, "message": err, "data": None}
    try:
        set_obj.stop()
        return {"ok": True, "message": "Playback stopped", "data": None}
    except Exception as e:
        return {"ok": False, "message": str(e), "data": None}


def ableton_list_tracks() -> dict:
    set_obj, err = _try_ableton()
    if err:
        return {"ok": False, "message": err, "data": None}
    try:
        tracks = []
        for i, tr in enumerate(set_obj.tracks):
            clips = getattr(tr, "clips", []) or []
            tracks.append({"index": i, "name": getattr(tr, "name", f"Track {i}"), "clips": len(clips)})
        return {"ok": True, "message": f"{len(tracks)} tracks", "data": {"tracks": tracks}}
    except Exception as e:
        return {"ok": False, "message": str(e), "data": None}


def ableton_scan_samples() -> dict:
    """Scan user's sample library. Returns categorized samples (kick, snare, hat, bass)."""
    try:
        from sample_scanner import scan_sample_library
        result = scan_sample_library()
        total = result.get("total", 0)
        samples = result.get("samples", {})
        msg = f"Found {total} samples"
        if samples:
            parts = [f"{k}: {len(v)}" for k, v in samples.items() if v]
            if parts:
                msg += " (" + ", ".join(parts) + ")"
        return {"ok": True, "message": msg, "data": result}
    except ImportError as e:
        return {"ok": False, "message": f"Sample scanner not available: {e}", "data": None}
    except Exception as e:
        return {"ok": False, "message": str(e), "data": None}


def ableton_create_audio_clip(track_index: int, slot_index: int, file_path: str) -> dict:
    """
    Create an audio clip from a file. Requires AbletonOSC with create_audio_clip (Live 12+).
    Returns ok/error. Clip slot must be empty and track must be audio.
    """
    set_obj, err = _try_ableton()
    if err:
        return {"ok": False, "message": err, "data": None}
    path = os.path.abspath(os.path.normpath(file_path))
    if not os.path.isfile(path):
        return {"ok": False, "message": f"File not found: {path}", "data": None}
    # Use forward slashes for OSC compatibility
    path_osc = path.replace("\\", "/")
    try:
        import live
        live.cmd("/live/clip_slot/create_audio_clip", (track_index, slot_index, path_osc))
        return {"ok": True, "message": f"Loaded {os.path.basename(path)} into track {track_index} slot {slot_index}", "data": {"path": path}}
    except Exception as e:
        return {"ok": False, "message": f"create_audio_clip failed (needs Ableton 12+ & AbletonOSC with create_audio_clip): {e}", "data": None}


def ableton_build_dubstep_full(midi_path: str | None = None) -> dict:
    """
    Full dubstep build: set tempo, scan samples, create audio tracks with user samples,
    generate MIDI (drums/bass/chords). Puts everything in Ableton.
    """
    set_obj, err = _try_ableton()
    if err:
        return {"ok": False, "message": err, "data": None}

    import os as _os
    steps: list[str] = []
    samples_used: list[str] = []

    # 1. Set tempo
    try:
        set_obj.tempo = 140
        steps.append("Tempo set to 140 BPM")
    except Exception as e:
        return {"ok": False, "message": f"Tempo failed: {e}", "data": None}

    # 2. Scan samples
    from sample_scanner import scan_sample_library
    scan = scan_sample_library()
    samples = scan.get("samples", {})

    def pick_sample(cat: str) -> str | None:
        lst = samples.get(cat, [])
        return lst[0]["path"] if lst else None

    kick_path = pick_sample("kick")
    snare_path = pick_sample("snare")
    hat_path = pick_sample("hat")
    bass_path = pick_sample("bass")

    # 3. Create audio tracks and try to load samples
    try:
        n_before = len(set_obj.tracks)
        # Create 4 new audio tracks at end
        for _ in range(4):
            set_obj.create_audio_track(-1)
        n_after = len(set_obj.tracks)
        track_indices = list(range(n_before, min(n_before + 4, n_after)))

        for i, (label, path) in enumerate(
            [("Kick", kick_path), ("Snare", snare_path), ("Hat", hat_path), ("Bass", bass_path)]
        ):
            if i < len(track_indices) and path and _os.path.isfile(path):
                try:
                    r = ableton_create_audio_clip(track_indices[i], 0, path)
                    if r.get("ok"):
                        steps.append(f"{label}: {_os.path.basename(path)}")
                        samples_used.append(path)
                except Exception:
                    pass
    except Exception as e:
        steps.append(f"Track creation: {e} (samples may need manual drag)")

    # 4. Generate MIDI song
    try:
        from midi_helper import generate_dubstep_song
        path = midi_path or _os.path.join(_os.path.expanduser("~"), "Desktop", "butlor_dubstep_song.mid")
        r = generate_dubstep_song(path, bpm=140, bars=8)
        if r.get("ok"):
            steps.append(f"MIDI: {path} (drag into Ableton)")
    except Exception as e:
        steps.append(f"MIDI: {e}")

    msg = " | ".join(steps)
    if samples_used:
        msg = f"Used {len(samples_used)} samples from your library. " + msg
    return {"ok": True, "message": msg, "data": {"steps": steps, "samples_used": samples_used}}
