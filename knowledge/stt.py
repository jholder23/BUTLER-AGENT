"""
Speech-to-text for Butler. Prints transcript to stdout.

1) WAV file:  python stt.py <path-to-wav>
2) Raw PCM:   python stt.py --pcm-s16le <sample_rate_hz> <path-to-raw-pcm>
   (mono 16-bit little-endian; host writes PCM so Python's wave module can wrap it reliably.)

Requires: SpeechRecognition. Google recognizer needs internet.
"""
import os
import sys
import tempfile
import wave


def _pcm_to_temp_wav(pcm_path: str, sample_rate: int) -> str:
    with open(pcm_path, "rb") as f:
        pcm = f.read()
    if len(pcm) < 2 or len(pcm) % 2 != 0:
        raise ValueError("PCM must be non-empty and an even number of bytes (int16 mono).")
    fd, wav_path = tempfile.mkstemp(suffix=".wav", prefix="butlor-stt-")
    os.close(fd)
    try:
        with wave.open(wav_path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(int(sample_rate))
            w.writeframes(pcm)
    except Exception:
        try:
            os.unlink(wav_path)
        except OSError:
            pass
        raise
    return wav_path


def main():
    args = sys.argv[1:]
    if not args:
        print("", end="")
        return

    path_in = None
    tmp_wav = None
    if len(args) >= 3 and args[0] == "--pcm-s16le":
        try:
            rate = int(args[1])
        except ValueError:
            print("Invalid sample rate", file=sys.stderr)
            sys.exit(1)
        pcm_path = args[2]
        if not os.path.isfile(pcm_path):
            print("", end="", file=sys.stderr)
            return
        if rate < 8000 or rate > 192000:
            print("Sample rate out of range", file=sys.stderr)
            sys.exit(1)
        try:
            tmp_wav = _pcm_to_temp_wav(pcm_path, rate)
            path_in = tmp_wav
        except Exception as e:
            print("STT error: " + str(e), file=sys.stderr)
            sys.exit(1)
    else:
        path_in = args[0]
        if not os.path.isfile(path_in):
            print("", end="", file=sys.stderr)
            return

    try:
        import speech_recognition as sr
    except ImportError as e:
        print("SpeechRecognition not installed: " + str(e), file=sys.stderr)
        sys.exit(1)

    r = sr.Recognizer()
    try:
        with sr.AudioFile(path_in) as source:
            audio = r.record(source)
        text = r.recognize_google(audio, language="en-US")
        print(text or "", end="")
    except sr.UnknownValueError:
        print("No speech recognized (speak closer to the mic or try again).", file=sys.stderr)
    except sr.RequestError as e:
        print("Google API failed (check internet): " + str(e), file=sys.stderr)
    except Exception as e:
        print("STT error: " + str(e), file=sys.stderr)
    finally:
        if tmp_wav:
            try:
                os.unlink(tmp_wav)
            except OSError:
                pass


if __name__ == "__main__":
    main()
