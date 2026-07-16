"""CLI for Ableton/MIDI. Usage: python ableton_cli.py <action> [args...]"""
import json
import os
import sys

# Ensure script dir is in path (fixes "No module named 'ableton_helper'" when run from Electron)
_script_dir = os.path.dirname(os.path.abspath(__file__))
if _script_dir and _script_dir not in sys.path:
    sys.path.insert(0, _script_dir)


def main():
    args = sys.argv[1:]
    if not args:
        print(json.dumps({"ok": False, "message": "Usage: ableton_cli.py <status|tempo|play|stop|tracks|midi|dubstep|samples> [bpm or path]"}))
        return
    action = args[0].lower()
    try:
        if action == "status":
            from ableton_helper import ableton_status
            r = ableton_status()
        elif action == "dubstep" or action == "dubstep_full":
            from ableton_helper import ableton_build_dubstep_full
            path = args[1] if len(args) > 1 else os.path.join(os.path.expanduser("~"), "Desktop", "butlor_dubstep_song.mid")
            r = ableton_build_dubstep_full(midi_path=path)
        elif action == "samples":
            from ableton_helper import ableton_scan_samples
            r = ableton_scan_samples()
        elif action == "tempo":
            from ableton_helper import ableton_set_tempo
            bpm = float(args[1]) if len(args) > 1 else 120
            r = ableton_set_tempo(bpm)
        elif action == "play":
            from ableton_helper import ableton_play
            r = ableton_play()
        elif action == "stop":
            from ableton_helper import ableton_stop
            r = ableton_stop()
        elif action == "tracks":
            from ableton_helper import ableton_list_tracks
            r = ableton_list_tracks()
        elif action == "midi":
            from midi_helper import generate_drum_pattern
            path = args[1] if len(args) > 1 else os.path.join(os.path.expanduser("~"), "Desktop", "butlor_drums.mid")
            bpm = float(args[2]) if len(args) > 2 else 120
            style = args[3].lower() if len(args) > 3 else "basic"
            r = generate_drum_pattern(path, bpm=bpm, style=style)
        else:
            r = {"ok": False, "message": f"Unknown action: {action}"}
    except Exception as e:
        r = {"ok": False, "message": str(e)}
    print(json.dumps(r))


if __name__ == "__main__":
    main()
