import React, { useEffect, useMemo, useState } from 'react';
import { fetchButlerJson, fetchButlerJsonWithResponse } from '../lib/fetchButlerJson';
import { Img2ImgPanel, type Img2ImgStudioMode } from './Img2ImgPanel';

export type PoseReferenceImage = {
  dataUrl: string;
  name: string;
  base64: string;
};

type CheckpointResponse = {
  ok?: boolean;
  message?: string;
  checkpoints?: string[];
  selected_checkpoint?: string;
  effective_checkpoint?: string;
};

type Txt2ImgResponse = {
  ok?: boolean;
  message?: string;
  images?: string[];
};

type StudioTab = 'pose' | Img2ImgStudioMode;

const POSE_WORKFLOW = 'txt2img_pose_reference_controlnet';

const DEFAULT_PROMPT =
  'standing with arms slightly away from the body, facing camera, legs slightly apart, ' +
  'head to toe visible, both hands and both feet fully in frame';

const DEFAULT_NEGATIVE =
  'anime, manga, cartoon, comic, chibi, illustration, illustrated, 2d animation, cel shading, anime style, ' +
  'drawn, sketch, painting, stylized art, waifu, pixiv, lineart, comic book, cartoonish, toon, ' +
  'skeleton, bones, skull, anatomical chart, stick figure, wireframe, silhouette, black silhouette, ' +
  'abstract shape, blob, featureless body, shadow figure, mannequin, doll, robot, wrong pose, ignored pose, ' +
  'different pose, flat on back with legs extended, melted feet, arms in wrong position, hands in wrong position, ' +
  'legs in wrong position, multiple people, crowd, busy background, scenery, furniture, props, clutter, ' +
  'cropped body, out of frame, cut off head, cut off feet, hidden hands, hidden feet, missing limbs, extra limbs, ' +
  'fused limbs, overlapping limbs, text, watermark, logo, nude, nsfw, photoreal fashion, ' +
  "high angle when eye-level requested, bird's eye, top-down when not requested";

const ASPECT_SIZES = {
  portrait: { width: 768, height: 1152, label: 'Portrait 2:3' },
  square: { width: 1024, height: 1024, label: 'Square 1:1' },
  landscape: { width: 1152, height: 768, label: 'Landscape 3:2' },
} as const;

type Aspect = keyof typeof ASPECT_SIZES;

const TABS: { id: StudioTab; label: string }[] = [
  { id: 'pose', label: 'Pose ref' },
  { id: 'easy', label: 'Easy FaceID' },
  { id: 'pose_control', label: 'Face + Pose' },
  { id: 'new_scene', label: 'New Scene' },
];

function imageDataUrl(base64: string): string {
  return `data:image/png;base64,${base64.replace(/\s/g, '')}`;
}

function PoseGeneratorPanel({
  onUsePose,
  poseReference,
}: {
  onUsePose: (image: PoseReferenceImage) => void;
  poseReference: PoseReferenceImage | null;
}) {
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [negativePrompt, setNegativePrompt] = useState(DEFAULT_NEGATIVE);
  const [aspect, setAspect] = useState<Aspect>('portrait');
  const [cfg, setCfg] = useState(6.5);
  const [steps, setSteps] = useState(28);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<PoseReferenceImage | null>(poseReference);

  useEffect(() => {
    if (poseReference) setResult(poseReference);
  }, [poseReference]);

  const composedPrompt = useMemo(() => prompt.trim(), [prompt]);

  const generate = async () => {
    if (!prompt.trim()) {
      setStatus('Enter a pose description.');
      return;
    }
    setBusy(true);
    setResult(null);
    setStatus('Building OpenPose map + ControlNet pose reference…');
    try {
      const size = ASPECT_SIZES[aspect];
      const { res, data: out } = await fetchButlerJsonWithResponse<Txt2ImgResponse>('/api/sd/txt2img', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: composedPrompt,
          negative_prompt: negativePrompt.trim(),
          width: size.width,
          height: size.height,
          workflow: POSE_WORKFLOW,
          steps,
          cfg,
        }),
      });
      const base64 = out.images?.[0]?.trim() || '';
      if (!res.ok || !out.ok || !base64) {
        throw new Error(out.message || `Pose generation failed (HTTP ${res.status}).`);
      }
      const image = {
        base64,
        dataUrl: imageDataUrl(base64),
        name: `butler-pose-reference-${Date.now()}.png`,
      };
      setResult(image);
      setStatus(out.message || 'Pose reference generated (OpenPose ControlNet).');
    } catch (e: unknown) {
      setStatus(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <p className="settings-desc" style={{ margin: '0 0 8px' }}>
        Pose reference for DWPose / OpenPose — describe one person&apos;s body pose. Butler builds an OpenPose
        skeleton from your text, then locks Juggernaut XL to it with OpenPose ControlNet (high strength). Defaults to
        a clean photoreal / realistic clothed figure on a plain background — not anime, illustration, or abstract
        silhouettes. Camera cues like &quot;eye level&quot; / &quot;level with the ground&quot; / &quot;head on&quot; are
        applied to framing and the prompt lock.
      </p>
      <label className="settings-desc" htmlFor="pose-reference-prompt" style={{ display: 'block' }}>
        Pose prompt
      </label>
      <textarea
        id="pose-reference-prompt"
        className="settings-input"
        rows={4}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        disabled={busy}
        spellCheck={false}
        placeholder="Describe the body pose only (arms, legs, facing)…"
      />
      <label className="settings-desc" htmlFor="pose-reference-negative" style={{ display: 'block', marginTop: 8 }}>
        Avoid
      </label>
      <textarea
        id="pose-reference-negative"
        className="settings-input"
        rows={2}
        value={negativePrompt}
        onChange={(e) => setNegativePrompt(e.target.value)}
        disabled={busy}
        spellCheck={false}
      />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginTop: 8 }}>
        <label className="settings-desc">
          Aspect
          <select
            className="settings-input"
            value={aspect}
            onChange={(e) => setAspect(e.target.value as Aspect)}
            disabled={busy}
            style={{ marginTop: 3 }}
          >
            {(Object.keys(ASPECT_SIZES) as Aspect[]).map((key) => (
              <option key={key} value={key}>
                {ASPECT_SIZES[key].label}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-desc">
          CFG ({cfg.toFixed(1)})
          <input
            className="settings-input"
            type="number"
            min={4}
            max={12}
            step={0.5}
            value={cfg}
            onChange={(e) => setCfg(Math.max(4, Math.min(12, Number(e.target.value) || 6.5)))}
            disabled={busy}
            style={{ marginTop: 3 }}
          />
        </label>
        <label className="settings-desc">
          Steps
          <input
            className="settings-input"
            type="number"
            min={16}
            max={40}
            step={1}
            value={steps}
            onChange={(e) => setSteps(Math.max(16, Math.min(40, Math.trunc(Number(e.target.value) || 28))))}
            disabled={busy}
            style={{ marginTop: 3 }}
          />
        </label>
      </div>
      <button
        type="button"
        className="settings-save"
        onClick={() => void generate()}
        disabled={busy || !prompt.trim()}
        style={{ marginTop: 10 }}
      >
        {busy ? 'Generating…' : 'Generate pose reference'}
      </button>
      {status ? (
        <p className="settings-learn-status-line settings-learn-status--muted" style={{ marginTop: 7 }}>
          {status}
        </p>
      ) : null}
      {result ? (
        <figure className="settings-generated-image-card" style={{ margin: '10px 0 0', maxWidth: 320 }}>
          <img src={result.dataUrl} alt="Generated pose reference" className="settings-generated-image-thumb" />
          <figcaption style={{ display: 'flex', flexWrap: 'wrap', gap: 8, paddingTop: 8 }}>
            <button type="button" className="settings-save" onClick={() => onUsePose(result)}>
              Use as pose reference
            </button>
            <a className="settings-secondary-btn" href={result.dataUrl} download={result.name}>
              Download
            </a>
          </figcaption>
        </figure>
      ) : null}
    </div>
  );
}

export function SecretMenuImageTools({
  onUsePose,
  poseReference = null,
}: {
  onUsePose: (image: PoseReferenceImage) => void;
  poseReference?: PoseReferenceImage | null;
}) {
  const [tab, setTab] = useState<StudioTab>('pose');
  const [checkpoints, setCheckpoints] = useState<string[]>([]);
  const [checkpoint, setCheckpoint] = useState('');
  const [modelBusy, setModelBusy] = useState(false);
  const [modelStatus, setModelStatus] = useState('');

  const loadCheckpoints = async () => {
    setModelBusy(true);
    try {
      const out = await fetchButlerJson<CheckpointResponse>('/api/sd/checkpoints');
      if (!out.ok) throw new Error(out.message || 'Could not load ComfyUI checkpoints.');
      const available = Array.isArray(out.checkpoints) ? out.checkpoints : [];
      setCheckpoints(available);
      const current = out.selected_checkpoint || out.effective_checkpoint || '';
      setCheckpoint(available.includes(current) ? current : '');
      setModelStatus(available.length ? '' : 'No ComfyUI checkpoints found.');
    } catch (e: unknown) {
      setModelStatus(String((e as Error)?.message || e));
    } finally {
      setModelBusy(false);
    }
  };

  useEffect(() => {
    void loadCheckpoints();
  }, []);

  const chooseCheckpoint = async (value: string) => {
    if (!value) return;
    setCheckpoint(value);
    setModelBusy(true);
    setModelStatus('Saving model selection…');
    try {
      const out = await fetchButlerJson<CheckpointResponse>('/api/sd/checkpoints', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkpoint: value }),
      });
      if (!out.ok) throw new Error(out.message || 'Could not save the model selection.');
      setModelStatus(out.message || 'Model selection saved.');
    } catch (e: unknown) {
      setModelStatus(String((e as Error)?.message || e));
      await loadCheckpoints();
    } finally {
      setModelBusy(false);
    }
  };

  const usePoseAndSwitch = (image: PoseReferenceImage) => {
    onUsePose(image);
    setTab('pose_control');
  };

  return (
    <div className="secret-menu-easy-img2img secret-menu-image-studio" style={{ marginTop: 16 }}>
      <p className="settings-desc secret-menu-prompting-title" style={{ margin: '0 0 8px' }}>
        Image studio
      </p>
      <label className="settings-desc" htmlFor="secret-menu-checkpoint" style={{ display: 'block' }}>
        Butler image model
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8 }}>
        <select
          id="secret-menu-checkpoint"
          className="settings-input"
          value={checkpoint}
          onChange={(e) => void chooseCheckpoint(e.target.value)}
          disabled={modelBusy || checkpoints.length === 0}
        >
          <option value="">{checkpoints.length ? 'Choose a checkpoint…' : 'No checkpoints found'}</option>
          {checkpoints.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <button type="button" className="settings-secondary-btn" onClick={() => void loadCheckpoints()} disabled={modelBusy}>
          Refresh
        </button>
      </div>
      {modelStatus ? (
        <p className="settings-learn-status-line settings-learn-status--muted" style={{ marginTop: 6 }}>
          {modelStatus}
        </p>
      ) : null}

      <div className="secret-menu-image-studio-tabs" role="tablist" aria-label="Image workflows" style={{ marginTop: 12 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`secret-menu-image-studio-tab${tab === t.id ? ' secret-menu-image-studio-tab--active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div
        role="tabpanel"
        style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}
      >
        {tab === 'pose' ? (
          <PoseGeneratorPanel onUsePose={usePoseAndSwitch} poseReference={poseReference} />
        ) : (
          <Img2ImgPanel
            key={tab}
            embedded
            studioMode={tab as Img2ImgStudioMode}
            poseReference={tab === 'pose_control' ? poseReference : null}
          />
        )}
      </div>
    </div>
  );
}
