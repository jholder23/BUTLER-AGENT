import { useEffect, useState } from 'react';
import { ButlerAvatar3D } from './ButlerAvatar3D';

export function ButlerFloatWindow() {
  const [speaking, setSpeaking] = useState(false);
  const [voiceActive, setVoiceActive] = useState(true);
  const [userSpeaking, setUserSpeaking] = useState(false);
  const [heardPreview, setHeardPreview] = useState<string | null>(null);
  const [voicePaused, setVoicePaused] = useState(false);
  const [micMuted, setMicMuted] = useState(false);

  useEffect(() => {
    document.documentElement.classList.add('butler-float-root');
    document.body.style.background = 'transparent';
    return () => {
      document.documentElement.classList.remove('butler-float-root');
      document.body.style.background = '';
    };
  }, []);

  useEffect(() => {
    const api = window.butlerFloat;
    if (!api?.onState) return;
    return api.onState((s) => {
      setSpeaking(!!s.speaking);
      setVoiceActive(s.voiceActive !== false);
      setUserSpeaking(!!s.userSpeaking);
      setHeardPreview(typeof s.heardPreview === 'string' ? s.heardPreview : null);
      setVoicePaused(!!s.voicePaused);
      setMicMuted(!!s.micMuted);
    });
  }, []);

  const capClass = micMuted
    ? 'butler-float-voice-caption--paused'
    : voicePaused
      ? 'butler-float-voice-caption--paused'
      : heardPreview
        ? 'butler-float-voice-caption--heard'
        : userSpeaking
          ? 'butler-float-voice-caption--speaking'
          : 'butler-float-voice-caption--idle';

  const capText = micMuted
    ? 'Mic muted — tap mic to speak'
    : voicePaused
      ? 'Paused…'
      : heardPreview
        ? `Heard: “${heardPreview.length > 40 ? `${heardPreview.slice(0, 40)}…` : heardPreview}”`
        : userSpeaking
          ? 'Hearing you…'
          : 'Listening…';

  return (
    <div className="butler-float-shell">
      <button
        type="button"
        className="butler-float-mic"
        onClick={() => window.butlerFloat?.toggleMicMute?.()}
        aria-pressed={micMuted}
        aria-label={micMuted ? 'Unmute microphone' : 'Mute microphone'}
        title={micMuted ? 'Unmute mic' : 'Mute mic'}
      >
        {micMuted ? '🔇' : '🎤'}
      </button>
      <button
        type="button"
        className="butler-float-close"
        onClick={() => window.butlerFloat?.hide()}
        aria-label="Dock Butler"
      >
        ×
      </button>
      <div className="butler-float-sphere">
        <ButlerAvatar3D speaking={speaking} voiceActive={voiceActive} layout="float" />
      </div>
      <div className={`butler-float-voice-caption ${capClass}`} aria-live="polite">
        {capText}
      </div>
    </div>
  );
}
