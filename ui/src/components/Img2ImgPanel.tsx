import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchButlerJson, fetchButlerJsonWithResponse } from '../lib/fetchButlerJson';
import { isElectronButler } from '../lib/electronEnv';
import { butlerApiUrl } from '../lib/butlerApiBase';
import { SECRET_MENU_NSFW_PROMPT_SNIPPETS } from '../secretMenuNsfwPrompts';
import type { PoseReferenceImage } from './SecretMenuImageTools';

/** Easy FaceID graph — same boxes as Comfy ButlerEasyPrompt. */
export const DEFAULT_NSFW_IMG2IMG_WORKFLOW = 'img2img_juggernaut_faceid_easy_nsfw';
export const POSE_CONTROL_IMG2IMG_WORKFLOW = 'img2img_juggernaut_faceid_openpose_action_nsfw';
export const NEW_SCENE_IMG2IMG_WORKFLOW = 'img2img_juggernaut_faceid_new_scene_nsfw';

export type Img2ImgStudioMode = 'easy' | 'pose_control' | 'new_scene';

const POSE_CONTROL_BASE_PROMPT =
  '(same adult person as the face reference:1.5), preserve exact facial identity and likeness, ' +
  '(follow the pose reference body geometry:1.35), coherent anatomy and hand placement, photorealistic RAW photograph, ' +
  'natural skin texture, realistic lighting';
const POSE_CONTROL_BASE_NEGATIVE =
  'different person, identity drift, wrong face, ignored pose reference, malformed anatomy, extra limbs, extra fingers, ' +
  'missing fingers, blurry face, lowres, illustration, CGI, watermark, text';

type Img2ImgResult = {
  ok?: boolean;
  message?: string;
  images?: string[];
  path?: string;
  variant_labels?: string[];
};

type SweepResultItem = {
  filename: string;
  preset: string;
  modified_at: string;
  bytes: number;
  winner: boolean;
  image_url: string;
};

type SweepRunGroup = {
  key: string;
  label: string;
  item_count: number;
  latest: string;
  items: SweepResultItem[];
};

type SweepResultsResponse = {
  ok?: boolean;
  message?: string;
  items?: SweepResultItem[];
  run_groups?: SweepRunGroup[];
  latest_run_key?: string;
  winner_files?: string[];
  winner_presets?: string[];
  output_path?: string;
};

type SavedPromptPreset = {
  id: string;
  name: string;
  updated_at: string;
  payload_base64: string;
};

type Framing = 'full_body' | 'waist_up' | 'medium' | 'portrait';
type EasyMode = 'single' | 'sweep_winners' | 'sweep_20';
type CreativePlacement = 'prepend' | 'append';
type EasyPreset =
  | 'custom'
  | '01_face_lock'
  | '02_soft_face'
  | '03_balanced'
  | '04_prompt_lean'
  | '05_action_first'
  | '06_strong_prompt'
  | '07_low_cfg_face'
  | '08_mid_cfg'
  | '09_high_cfg'
  | '10_short_end'
  | '11_long_end'
  | '12_soft_lora'
  | '13_mid_lora'
  | '14_high_lora'
  | '15_v2_soft'
  | '16_v2_strong'
  | '17_cfg60_mid'
  | '18_cfg65_mid'
  | '19_steps_high'
  | '20_high_lora_face';

const EASY_PRESETS: EasyPreset[] = ['custom'];

export type EasyPromptFields = {
  details: string;
  avoid: string;
  action: string;
  pose: string;
  outfit: string;
  scene: string;
  creative_prompt: string;
  creative_placement: CreativePlacement;
  pose_strength: number;
  pose_end_percent: number;
  mode: EasyMode;
  sweep_seed: number;
  balance: number;
  framing: Framing;
  emphasize_action: boolean;
  hands_in_frame: boolean;
  frontal_face: boolean;
  photoreal: boolean;
  preset: EasyPreset;
};

const DEFAULT_EASY: EasyPromptFields = {
  details: '',
  avoid: '',
  action: '',
  pose: '',
  outfit: '',
  scene: '',
  creative_prompt: '',
  creative_placement: 'append',
  pose_strength: 0.9,
  pose_end_percent: 0.8,
  mode: 'single',
  sweep_seed: 0,
  balance: 0.35,
  framing: 'full_body',
  emphasize_action: true,
  hands_in_frame: true,
  frontal_face: true,
  photoreal: true,
  preset: '20_high_lora_face',
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// Simple XOR encoding for face reference privacy (not cryptographic security, but prevents casual inspection)
const ENCRYPTION_KEY = 'butler-face-ref-secure-key-2024';

function encodeFaceRef(base64: string): string {
  try {
    const key = ENCRYPTION_KEY;
    let encoded = '';
    for (let i = 0; i < base64.length; i++) {
      encoded += String.fromCharCode(base64.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return btoa(encoded);
  } catch {
    return base64;
  }
}

function decodeFaceRef(encoded: string): string {
  try {
    const key = ENCRYPTION_KEY;
    const decoded = atob(encoded);
    let original = '';
    for (let i = 0; i < decoded.length; i++) {
      original += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return original;
  } catch {
    return encoded;
  }
}

function parseDataUrl(dataUrl: string): { mime: string; base64: string } | null {
  const s = dataUrl.trim();
  const marker = ';base64,';
  const i = s.indexOf(marker);
  if (!s.toLowerCase().startsWith('data:') || i < 5) return null;
  const mime = s.slice(5, i).trim() || 'application/octet-stream';
  const base64 = s.slice(i + marker.length).replace(/\s/g, '');
  if (!base64) return null;
  return { mime, base64 };
}

function base64ToObjectUrl(base64: string, mime = 'image/png'): string | null {
  try {
    const raw = base64.trim();
    if (!raw || raw.length < 40) return null;
    if (raw.startsWith('data:')) return null;
    const binStr = atob(raw);
    const u8 = new Uint8Array(binStr.length);
    for (let i = 0; i < binStr.length; i++) u8[i] = binStr.charCodeAt(i);
    return URL.createObjectURL(new Blob([u8], { type: mime }));
  } catch {
    return null;
  }
}

function balanceLabel(v: number): string {
  if (v < -0.33) return 'FACE (likeness)';
  if (v > 0.33) return 'PROMPT (action / pose)';
  return 'CENTER (compromise)';
}

function decodeEasyPromptPreset(payloadBase64: string): EasyPromptFields {
  const bytes = Uint8Array.from(atob(payloadBase64), (c) => c.charCodeAt(0));
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as Partial<EasyPromptFields>;
  const mode: EasyMode = ['single', 'sweep_winners', 'sweep_20'].includes(String(raw.mode))
    ? (raw.mode as EasyMode)
    : DEFAULT_EASY.mode;
  const framing: Framing = ['full_body', 'waist_up', 'medium', 'portrait'].includes(String(raw.framing))
    ? (raw.framing as Framing)
    : DEFAULT_EASY.framing;
  const preset = EASY_PRESETS.includes(raw.preset as EasyPreset) ? (raw.preset as EasyPreset) : DEFAULT_EASY.preset;
  return {
    details: String(raw.details ?? ''),
    avoid: String(raw.avoid ?? ''),
    action: String(raw.action ?? ''),
    pose: String(raw.pose ?? ''),
    outfit: String(raw.outfit ?? ''),
    scene: String(raw.scene ?? ''),
    creative_prompt: String(raw.creative_prompt ?? ''),
    creative_placement: raw.creative_placement === 'prepend' ? 'prepend' : 'append',
    pose_strength: Math.max(0.35, Math.min(1.25, Number(raw.pose_strength) || DEFAULT_EASY.pose_strength)),
    pose_end_percent: Math.max(0.35, Math.min(1, Number(raw.pose_end_percent) || DEFAULT_EASY.pose_end_percent)),
    mode,
    sweep_seed: Math.max(0, Math.trunc(Number(raw.sweep_seed) || 0)),
    balance: Math.max(-1, Math.min(1, Number(raw.balance) || 0)),
    framing,
    emphasize_action: Boolean(raw.emphasize_action),
    hands_in_frame: Boolean(raw.hands_in_frame),
    frontal_face: Boolean(raw.frontal_face),
    photoreal: Boolean(raw.photoreal),
    preset,
  };
}

type Props = {
  /** Compact layout for embedding inside the utility panel. */
  embedded?: boolean;
  /** A pose generated by the utility panel's txt2img tool. */
  poseReference?: PoseReferenceImage | null;
  /** When set, lock to one Butler workflow and show only its inputs. */
  studioMode?: Img2ImgStudioMode;
};

export function Img2ImgPanel({ embedded = false, poseReference = null, studioMode }: Props) {
  const [easy, setEasy] = useState<EasyPromptFields>(DEFAULT_EASY);
  const [sourceImage, setSourceImage] = useState<{ dataUrl: string; name: string; base64: string } | null>(null);
  const [poseImage, setPoseImage] = useState<{ dataUrl: string; name: string; base64: string } | null>(null);
  const [storedFaceRefs, setStoredFaceRefs] = useState<Array<{ id: string; name: string; encodedData: string; createdAt: number }>>([]);
  const [winnerPresets, setWinnerPresets] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [statusLine, setStatusLine] = useState('');
  const [result, setResult] = useState<Img2ImgResult | null>(null);
  const [outputUrls, setOutputUrls] = useState<Array<{ url: string; label?: string }>>([]);
  const [showSweepGallery, setShowSweepGallery] = useState(false);
  const [sweepItems, setSweepItems] = useState<SweepResultItem[]>([]);
  const [runGroups, setRunGroups] = useState<SweepRunGroup[]>([]);
  const [selectedRunKey, setSelectedRunKey] = useState('');
  const [winnerDraft, setWinnerDraft] = useState<Set<string>>(new Set());
  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepStatus, setSweepStatus] = useState('');
  const [sweepProgress, setSweepProgress] = useState<number | null>(null);
  const [sweepProgressTotal, setSweepProgressTotal] = useState<number | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerFullscreen, setViewerFullscreen] = useState(false);
  /** sweep gallery vs single/session returns in the detached utility menu */
  const [viewerSource, setViewerSource] = useState<'sweep' | 'single'>('sweep');
  const [viewAllRuns, setViewAllRuns] = useState(false);
  const sweepProgressInterval = useRef<number | null>(null);
  const [promptPresets, setPromptPresets] = useState<SavedPromptPreset[]>([]);
  const [selectedPromptPresetId, setSelectedPromptPresetId] = useState('');
  const [promptPresetName, setPromptPresetName] = useState('');
  const [promptPresetBusy, setPromptPresetBusy] = useState(false);
  const [promptPresetStatus, setPromptPresetStatus] = useState('');
  const urlRefs = useRef<string[]>([]);
  const logRef = useRef<HTMLPreElement | null>(null);
  const [activityLog, setActivityLog] = useState<string[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const setField = <K extends keyof EasyPromptFields>(key: K, value: EasyPromptFields[K]) => {
    setEasy((prev) => ({ ...prev, [key]: value }));
  };

  const pushLog = (line: string) => {
    const ts = new Date().toLocaleTimeString();
    const msg = `[${ts}] ${String(line || '').trim()}`;
    setActivityLog((prev) => {
      const next = [...prev, msg];
      return next.length > 120 ? next.slice(-120) : next;
    });
  };

  const cleanupUrls = () => {
    for (const u of urlRefs.current) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        /* ignore */
      }
    }
    urlRefs.current = [];
    setOutputUrls([]);
  };

  const cancelSweepProgressPolling = () => {
    if (sweepProgressInterval.current !== null) {
      window.clearInterval(sweepProgressInterval.current);
      sweepProgressInterval.current = null;
    }
  };

  const updateSweepProgress = async () => {
    try {
      const out = await fetchButlerJson<SweepResultsResponse>('/api/sd/img2img/sweep-results');
      if (!out.ok) return;
      const latest = out.items || [];
      const total = easy.mode === 'sweep_20' ? 20 : out.winner_presets?.length || null;
      setSweepProgress(latest.length);
      setSweepProgressTotal(total);
      if (total && latest.length >= total) {
        cancelSweepProgressPolling();
      }
    } catch {
      // ignore transient polling errors
    }
  };

  useEffect(() => {
    return () => cancelSweepProgressPolling();
  }, []);

  useEffect(() => {
    if (viewAllRuns) {
      const allItems = runGroups.flatMap((run) => run.items);
      setSweepItems(allItems);
      return;
    }
    if (selectedRunKey) {
      const selected = runGroups.find((run) => run.key === selectedRunKey);
      if (selected) {
        setSweepItems(selected.items);
      }
    }
  }, [selectedRunKey, runGroups, viewAllRuns]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [activityLog]);

  useEffect(() => {
    if (!poseReference) return;
    setPoseImage(poseReference);
    setErr(null);
    setStatusLine('Generated pose reference attached. Add a face photo, then run pose control.');
    pushLog(`Generated pose reference attached: ${poseReference.name}`);
  }, [poseReference]);

  useEffect(() => {
    void loadPromptPresets();
    void loadStoredFaceRefs();
  }, []);

  const loadStoredFaceRefs = () => {
    try {
      const stored = localStorage.getItem('butler-face-refs');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed)) {
          setStoredFaceRefs(parsed);
        }
      }
    } catch {
      // Ignore storage errors
    }
  };

  const saveFaceRef = (image: { dataUrl: string; name: string; base64: string }) => {
    const encoded = encodeFaceRef(image.base64);
    const newRef = {
      id: `face-ref-${Date.now()}`,
      name: image.name,
      encodedData: encoded,
      createdAt: Date.now(),
    };
    const updated = [...storedFaceRefs, newRef];
    setStoredFaceRefs(updated);
    try {
      localStorage.setItem('butler-face-refs', JSON.stringify(updated));
      setSourceImage(null); // Hard delete original after saving
      pushLog(`Face reference saved and original deleted: ${image.name}`);
    } catch {
      pushLog('Failed to save face reference to storage');
    }
  };

  const loadFaceRef = (ref: { id: string; name: string; encodedData: string }) => {
    try {
      const decoded = decodeFaceRef(ref.encodedData);
      const dataUrl = `data:image/png;base64,${decoded}`;
      setSourceImage({ dataUrl, name: ref.name, base64: decoded });
      pushLog(`Face reference loaded: ${ref.name}`);
    } catch {
      pushLog(`Failed to load face reference: ${ref.name}`);
    }
  };

  const deleteFaceRef = (id: string) => {
    const updated = storedFaceRefs.filter((ref) => ref.id !== id);
    setStoredFaceRefs(updated);
    try {
      localStorage.setItem('butler-face-refs', JSON.stringify(updated));
      pushLog('Face reference deleted');
    } catch {
      pushLog('Failed to delete face reference from storage');
    }
  };

  const canRun = useMemo(() => {
    if (!sourceImage?.base64 || busy) return false;
    if (studioMode === 'pose_control') return !!poseImage?.base64;
    return true;
  }, [sourceImage, poseImage, busy, studioMode]);

  const poseControlActive = studioMode === 'pose_control' || (!studioMode && !!poseImage?.base64);
  const showPoseUpload = studioMode === 'pose_control' || !studioMode;
  const showEasyBoxes = studioMode !== 'pose_control';
  const showPoseControls = poseControlActive;
  const showSweepControls = studioMode === 'easy' || !studioMode;

  const processImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setErr('Choose an image file (PNG, JPEG, WebP, etc.).');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setErr(`Image is too large (max ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB).`);
      return;
    }
    setErr(null);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) {
        setErr('Could not read the image.');
        return;
      }
      setSourceImage({ dataUrl, name: file.name || 'reference.png', base64: parsed.base64 });
      pushLog(`Reference loaded: ${file.name || 'image'} (${Math.round(file.size / 1024)} KB)`);
    };
    reader.readAsDataURL(file);
  };

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    processImageFile(f);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (!f) return;
    processImageFile(f);
  };

  const onPoseFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) {
      setErr('Choose an image file (PNG, JPEG, WebP, etc.).');
      return;
    }
    if (f.size > MAX_IMAGE_BYTES) {
      setErr(`Pose image is too large (max ${Math.round(MAX_IMAGE_BYTES / (1024 * 1024))} MB).`);
      return;
    }
    setErr(null);
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      const parsed = parseDataUrl(dataUrl);
      if (!parsed) {
        setErr('Could not read the pose image.');
        return;
      }
      setPoseImage({ dataUrl, name: f.name || 'pose-reference.png', base64: parsed.base64 });
      pushLog(`Pose reference loaded: ${f.name || 'image'} (${Math.round(f.size / 1024)} KB)`);
    };
    reader.readAsDataURL(f);
  };

  const appendToAction = (snippet: string) => {
    setEasy((prev) => {
      const p = prev.action.trim();
      if (!p) return { ...prev, action: snippet };
      if (p.endsWith(',') || p.endsWith('.')) return { ...prev, action: `${p} ${snippet}` };
      return { ...prev, action: `${p}, ${snippet}` };
    });
  };

  const loadPromptPresets = async () => {
    try {
      const out = await fetchButlerJson<{ ok?: boolean; message?: string; presets?: SavedPromptPreset[] }>(
        '/api/sd/img2img/prompt-presets',
      );
      if (!out.ok) throw new Error(out.message || 'Could not load prompt presets.');
      setPromptPresets(Array.isArray(out.presets) ? out.presets : []);
    } catch (e: unknown) {
      setPromptPresetStatus(String((e as Error)?.message || e));
    }
  };

  const selectPromptPreset = (id: string) => {
    setSelectedPromptPresetId(id);
    const selected = promptPresets.find((preset) => preset.id === id);
    setPromptPresetName(selected?.name || '');
  };

  const applyPromptPreset = () => {
    const selected = promptPresets.find((preset) => preset.id === selectedPromptPresetId);
    if (!selected) {
      setPromptPresetStatus('Choose a saved prompt preset first.');
      return;
    }
    try {
      setEasy(decodeEasyPromptPreset(selected.payload_base64));
      setPromptPresetName(selected.name);
      setPromptPresetStatus(`Loaded "${selected.name}" into every Easy input.`);
      pushLog(`Loaded prompt preset: ${selected.name}`);
    } catch {
      setPromptPresetStatus(`Preset "${selected.name}" has invalid Base64 data.`);
    }
  };

  const savePromptPreset = async () => {
    const name = promptPresetName.trim();
    if (!name) {
      setPromptPresetStatus('Enter a preset name.');
      return;
    }
    setPromptPresetBusy(true);
    try {
      const selected = promptPresets.find((preset) => preset.id === selectedPromptPresetId);
      const updateId = selected?.name === name ? selected.id : undefined;
      const out = await fetchButlerJson<{
        ok?: boolean;
        message?: string;
        preset?: SavedPromptPreset;
      }>('/api/sd/img2img/prompt-presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, fields: easy, ...(updateId ? { id: updateId } : {}) }),
      });
      if (!out.ok || !out.preset) throw new Error(out.message || 'Could not save prompt preset.');
      setPromptPresetStatus(`${out.message || 'Saved.'} Stored as Base64.`);
      setSelectedPromptPresetId(out.preset.id);
      pushLog(out.message || `Saved prompt preset: ${name}`);
      await loadPromptPresets();
    } catch (e: unknown) {
      setPromptPresetStatus(String((e as Error)?.message || e));
    } finally {
      setPromptPresetBusy(false);
    }
  };

  const deletePromptPreset = async () => {
    const selected = promptPresets.find((preset) => preset.id === selectedPromptPresetId);
    if (!selected) {
      setPromptPresetStatus('Choose a saved prompt preset first.');
      return;
    }
    setPromptPresetBusy(true);
    try {
      const out = await fetchButlerJson<{ ok?: boolean; message?: string }>(
        `/api/sd/img2img/prompt-presets/${encodeURIComponent(selected.id)}`,
        { method: 'DELETE' },
      );
      if (!out.ok) throw new Error(out.message || 'Could not delete prompt preset.');
      setPromptPresets((items) => items.filter((item) => item.id !== selected.id));
      setSelectedPromptPresetId('');
      setPromptPresetName('');
      setPromptPresetStatus(out.message || 'Prompt preset deleted.');
      pushLog(`Deleted prompt preset: ${selected.name}`);
    } catch (e: unknown) {
      setPromptPresetStatus(String((e as Error)?.message || e));
    } finally {
      setPromptPresetBusy(false);
    }
  };

  const loadSweepResults = async (announce = false) => {
    setSweepBusy(true);
    try {
      const out = await fetchButlerJson<SweepResultsResponse>('/api/sd/img2img/sweep-results');
      if (!out.ok) throw new Error(out.message || 'Could not load sweep results.');
      const items = Array.isArray(out.items) ? out.items : [];
      const groups = Array.isArray(out.run_groups) ? out.run_groups : [];
      const latestRunKey = typeof out.latest_run_key === 'string' ? out.latest_run_key : groups[0]?.key || '';
      setRunGroups(groups);
      setSelectedRunKey(latestRunKey);
      setSweepItems(items);
      setWinnerDraft(new Set(Array.isArray(out.winner_files) ? out.winner_files : []));
      setWinnerPresets(Array.isArray(out.winner_presets) ? out.winner_presets : []);
      if (easy.mode === 'sweep_winners') {
        setSweepProgressTotal((out.winner_presets || []).length || null);
      }
      setSweepStatus(
        groups.length
          ? `${groups.length} run(s), ${items.length} result(s) · ${(out.winner_presets || []).length} winning preset(s)`
          : 'No saved sweep results yet.',
      );
      if (announce) pushLog(`Sweep gallery refreshed: ${items.length} result(s) across ${groups.length} run(s).`);
    } catch (e: unknown) {
      const msg = String((e as Error)?.message || e);
      setSweepStatus(msg);
      if (announce) pushLog(`Sweep gallery: ${msg}`);
    } finally {
      setSweepBusy(false);
    }
  };

  const toggleSweepGallery = () => {
    const next = !showSweepGallery;
    setShowSweepGallery(next);
    if (next) {
      void loadSweepResults();
    } else {
      setViewerOpen(false);
    }
  };

  // Auto-refresh sweep results while sweep is in progress
  useEffect(() => {
    if (!showSweepGallery) return;
    if (sweepBusy) {
      const interval = window.setInterval(() => {
        void loadSweepResults();
      }, 2000);
      return () => window.clearInterval(interval);
    }
  }, [showSweepGallery, sweepBusy]);

  const selectNextRun = () => {
    if (runGroups.length === 0) return;
    const currentIndex = runGroups.findIndex((run) => run.key === selectedRunKey);
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + 1) % runGroups.length;
    setSelectedRunKey(runGroups[nextIndex].key);
  };

  const openViewer = (index: number) => {
    const clamped = Math.max(0, Math.min(index, sweepItems.length - 1));
    setViewerSource('sweep');
    setViewerIndex(clamped);
    setViewerOpen(true);
    setViewerFullscreen(true);
  };

  const openSingleViewer = (index: number) => {
    const clamped = Math.max(0, Math.min(index, outputUrls.length - 1));
    setViewerSource('single');
    setViewerIndex(clamped);
    setViewerOpen(true);
    setViewerFullscreen(true);
  };

  const closeViewer = () => {
    setViewerOpen(false);
    setViewerFullscreen(false);
  };

  const viewerCount =
    viewerSource === 'single' ? outputUrls.length : sweepItems.length;
  const viewerItemUrl =
    viewerSource === 'single'
      ? outputUrls[viewerIndex]?.url || ''
      : sweepItems[viewerIndex]
        ? butlerApiUrl(sweepItems[viewerIndex].image_url)
        : '';
  const viewerItemLabel =
    viewerSource === 'single'
      ? outputUrls[viewerIndex]?.label || `Result ${viewerIndex + 1}`
      : sweepItems[viewerIndex]
        ? `${sweepItems[viewerIndex].preset} · ${sweepItems[viewerIndex].filename}`
        : '';

  // Keyboard navigation for the viewer modal
  useEffect(() => {
    if (!viewerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeViewer();
      } else if (e.key === 'ArrowLeft') {
        showPreviousViewer();
      } else if (e.key === 'ArrowRight') {
        showNextViewer();
      } else if (e.key === 'f' || e.key === 'F') {
        setViewerFullscreen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [viewerOpen, viewerCount, viewerSource]);

  const showPreviousViewer = () => {
    if (viewerCount === 0) return;
    setViewerIndex((current) => (current - 1 + viewerCount) % viewerCount);
  };

  const showNextViewer = () => {
    if (viewerCount === 0) return;
    setViewerIndex((current) => (current + 1) % viewerCount);
  };

  const toggleWinner = (filename: string) => {
    setWinnerDraft((current) => {
      const next = new Set(current);
      if (next.has(filename)) next.delete(filename);
      else next.add(filename);
      return next;
    });
  };

  const saveSweepWinners = async () => {
    setSweepBusy(true);
    try {
      const out = await fetchButlerJson<{
        ok?: boolean;
        message?: string;
        files?: string[];
        presets?: string[];
      }>('/api/sd/img2img/sweep-winners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: Array.from(winnerDraft) }),
      });
      if (!out.ok) throw new Error(out.message || 'Could not save sweep winners.');
      setSweepStatus(out.message || 'Sweep winners saved.');
      setSweepItems((items) => items.map((item) => ({ ...item, winner: winnerDraft.has(item.filename) })));
      pushLog(out.message || 'Sweep winners saved.');
    } catch (e: unknown) {
      const msg = String((e as Error)?.message || e);
      setSweepStatus(msg);
      pushLog(`Winner save failed: ${msg}`);
    } finally {
      setSweepBusy(false);
    }
  };

  const generate = async () => {
    if (!sourceImage?.base64) {
      setErr('Upload a face / reference image first.');
      return;
    }
    // Easy / new-scene: face-only. OpenPose dual-ref only for Face+Pose tab (or legacy standalone + pose upload).
    const poseControl = studioMode === 'pose_control' || (!studioMode && !!poseImage?.base64);
    if (studioMode === 'pose_control' && !poseImage?.base64) {
      setErr('Upload a pose reference image (or generate one in the Pose tab).');
      return;
    }
    setErr(null);
    setBusy(true);
    const workflow =
      studioMode === 'easy'
        ? DEFAULT_NSFW_IMG2IMG_WORKFLOW
        : studioMode === 'new_scene'
          ? NEW_SCENE_IMG2IMG_WORKFLOW
          : poseControl
            ? POSE_CONTROL_IMG2IMG_WORKFLOW
            : DEFAULT_NSFW_IMG2IMG_WORKFLOW;
    setStatusLine(
      studioMode === 'new_scene'
        ? 'Queuing FaceID new-scene generation…'
        : poseControl
          ? 'Queuing FaceID + DWPose scene generation…'
          : 'Queuing ComfyUI easy FaceID img2img…',
    );
    cleanupUrls();
    cancelSweepProgressPolling();
    setSweepProgress(null);
    setSweepProgressTotal(poseControl || studioMode === 'new_scene' ? null : easy.mode === 'sweep_20' ? 20 : null);
    setResult(null);
    const easy_prompt = { ...easy };
    const fallbackCreative = [easy.action, easy.pose, easy.outfit, easy.scene, easy.details]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(', ');
    const creativePrompt = easy.creative_prompt.trim() || fallbackCreative;
    const summaryPrompt = poseControl
      ? easy.creative_placement === 'prepend'
        ? [creativePrompt, POSE_CONTROL_BASE_PROMPT].filter(Boolean).join(', ')
        : [POSE_CONTROL_BASE_PROMPT, creativePrompt].filter(Boolean).join(', ')
      : studioMode === 'new_scene'
        ? fallbackCreative || 'same person, new scene'
        : fallbackCreative || 'easy FaceID img2img';
    const negativePrompt = poseControl
      ? [easy.avoid.trim(), POSE_CONTROL_BASE_NEGATIVE].filter(Boolean).join(', ')
      : easy.avoid.trim();
    pushLog(`POST /api/sd/img2img · workflow ${workflow}`);
    if (!poseControl && studioMode !== 'new_scene' && (easy.mode === 'sweep_20' || easy.mode === 'sweep_winners')) {
      setSweepStatus('Sweep in progress...');
      sweepProgressInterval.current = window.setInterval(() => {
        void updateSweepProgress();
      }, 1200);
    }
    try {
      const { res, data: out } = await fetchButlerJsonWithResponse<Img2ImgResult>('/api/sd/img2img', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: summaryPrompt,
          negative_prompt: negativePrompt,
          init_image: sourceImage.base64,
          workflow,
          filename: sourceImage.name,
          ...(poseControl
            ? {
                pose_image: poseImage!.base64,
                pose_filename: poseImage!.name,
                pose_strength: easy.pose_strength,
                pose_end_percent: easy.pose_end_percent,
              }
            : { easy_prompt }),
        }),
        // Knowledge polls Comfy up to ~6 min; Electron proxy allows 15. Cap UI so we never spin forever.
        signal: AbortSignal.timeout(16 * 60 * 1000),
      });
      setResult(out);
      if (!res.ok || !out.ok) {
        const msg =
          out.message ||
          (res.status === 502
            ? isElectronButler()
              ? 'Could not reach Butler Knowledge API / ComfyUI. In desktop Butler, Comfy should be on port 8198 (Status → Restart ComfyUI if needed).'
              : 'Could not reach Butler Knowledge API / ComfyUI. Run npm run dev:restart and ensure ComfyUI is on port 8188.'
            : `Image edit failed (HTTP ${res.status}).`);
        setErr(msg);
        setStatusLine('');
        pushLog(`Failed: ${msg.slice(0, 240)}`);
        return;
      }
      const labels = Array.isArray(out.variant_labels) ? out.variant_labels : [];
      const urls: Array<{ url: string; label?: string; encodedData?: string }> = [];
      (out.images || []).forEach((b64, i) => {
        const encoded = encodeFaceRef(b64); // Encode results for privacy
        const url = base64ToObjectUrl(b64); // Still decode for immediate display
        if (url) {
          urlRefs.current.push(url);
          urls.push({ url, label: labels[i] || (out.images!.length > 1 ? `Variant ${i + 1}` : undefined), encodedData: encoded });
        }
      });
      setOutputUrls(urls);
      if (easy.mode === 'sweep_20' || easy.mode === 'sweep_winners') {
        setSweepProgress(urls.length);
        setSweepProgressTotal(easy.mode === 'sweep_20' ? 20 : sweepProgressTotal);
      }
      const msg = out.message || `Done — ${urls.length} image(s).`;
      setStatusLine(msg);
      pushLog(msg);
      if (out.path) pushLog(`Saved: ${out.path}`);
      setShowSweepGallery(true);
      await loadSweepResults();
    } catch (e: unknown) {
      let msg = String((e as Error)?.message || e);
      if (/aborted|timeout|timed out/i.test(msg)) {
        msg = isElectronButler()
          ? 'Image edit timed out waiting for ComfyUI (port 8198). If Comfy already finished, check Status → Restart Knowledge, then retry.'
          : 'Image edit timed out waiting for ComfyUI. If Comfy already finished, run npm run dev:restart and retry.';
      } else if (/fetch failed|failed to fetch|networkerror|econnrefused/i.test(msg)) {
        msg = isElectronButler()
          ? 'Could not reach Butler desktop API (4011) / Knowledge (8775) / Comfy (8198). Use Status → Restart all, or relaunch Butler.exe.'
          : 'Could not reach Butler (API 4001 / Knowledge 8765). Run npm run dev:restart from the Butler repo. ' +
            'Stop Sine Language Animation Studio if it steals port 8765.';
      }
      setErr(msg);
      setStatusLine('');
      pushLog(`Error: ${msg.slice(0, 240)}`);
    } finally {
      cancelSweepProgressPolling();
      setBusy(false);
    }
  };

  const fieldId = (name: string) => (embedded ? `util-easy-${name}` : `img2img-easy-${name}`);

  const [minimized, setMinimized] = useState(false);

  if (minimized) {
    return (
      <div style={{ padding: '8px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="settings-desc" style={{ margin: 0 }}>
          {studioMode === 'pose_control'
            ? 'Face + Pose img2img (minimized)'
            : studioMode === 'new_scene'
              ? 'New Scene FaceID (minimized)'
              : 'Easy FaceID img2img (minimized)'}
        </span>
        <button
          type="button"
          className="settings-secondary-btn"
          onClick={() => setMinimized(false)}
          style={{ padding: '2px 12px' }}
        >
          ▼ Restore
        </button>
      </div>
    );
  }

  return (
    <div>
      {!studioMode ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <button
            type="button"
            className="settings-secondary-btn"
            onClick={() => setMinimized(true)}
            style={{ padding: '2px 12px', fontSize: '0.85em' }}
            title="Minimize panel (state is preserved)"
          >
            ▲ Minimize
          </button>
        </div>
      ) : null}
      {!embedded ? (
        <>
          <p className="settings-desc" style={{ marginTop: 0 }}>
            Easy FaceID img2img (
            <code>{DEFAULT_NSFW_IMG2IMG_WORKFLOW}</code>
            ) — same boxes as Comfy&apos;s <strong>Butler Easy Prompt</strong>. Empty boxes use defaults. Outputs land under{' '}
            <code>Documents/Butlor/generated</code>.
          </p>
          <p className="settings-learn-status-line settings-learn-status--muted">
            {isElectronButler() ? (
              <>
                Desktop: Knowledge API <strong>8775</strong> + ComfyUI <strong>8198</strong>. Install FaceID stack +{' '}
                <code>python scripts/install_butler_simple_ui.py</code>, then Status → Restart ComfyUI.
              </>
            ) : (
              <>
                Dev: Knowledge API <strong>8765</strong> + ComfyUI <strong>8188</strong>. Install FaceID stack +{' '}
                <code>python scripts/install_butler_simple_ui.py</code>, then restart Comfy.
              </>
            )}
          </p>
        </>
      ) : (
        <p className="settings-desc" style={{ marginTop: 0 }}>
          {studioMode === 'pose_control' ? (
            <>
              <strong>Face + Pose</strong> — face photo for identity, separate pose photo for DWPose. Creative prompt
              controls outfit/scene; pose strength controls how tightly the body follows the reference.
            </>
          ) : studioMode === 'new_scene' ? (
            <>
              <strong>New Scene</strong> — same face, new action/pose/outfit/scene via EmptyLatent + light FaceID +
              ReActor (no pose reference image).
            </>
          ) : (
            <>
              <strong>Easy FaceID</strong> — face photo + Butler Easy Prompt boxes (action, pose, outfit, scene).
            </>
          )}
        </p>
      )}

      {err ? <p className="settings-learn-status-line settings-learn-status--warn">{err}</p> : null}
      {statusLine && !err ? (
        <p className="settings-learn-status-line settings-learn-status--muted">{statusLine}</p>
      ) : null}

      {showEasyBoxes ? (
      <div
        style={{
          marginTop: 10,
          padding: 10,
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-sm)',
        }}
      >
        <p className="settings-desc" style={{ margin: '0 0 8px' }}>
          <strong>Prompt presets</strong> — one preset fills every Easy input. Payloads are stored as Base64.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(130px, 1fr) minmax(130px, 1fr)', gap: 8 }}>
          <select
            className="settings-input"
            value={selectedPromptPresetId}
            onChange={(e) => selectPromptPreset(e.target.value)}
            disabled={promptPresetBusy}
            aria-label="Saved Easy prompt preset"
          >
            <option value="">New preset…</option>
            {promptPresets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.name}
              </option>
            ))}
          </select>
          <input
            className="settings-input"
            value={promptPresetName}
            onChange={(e) => setPromptPresetName(e.target.value)}
            placeholder="Preset name"
            maxLength={80}
            disabled={promptPresetBusy}
            aria-label="Easy prompt preset name"
          />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
          <button
            type="button"
            className="settings-save"
            onClick={() => void savePromptPreset()}
            disabled={promptPresetBusy || !promptPresetName.trim()}
          >
            Save current inputs
          </button>
          <button
            type="button"
            className="settings-secondary-btn"
            onClick={applyPromptPreset}
            disabled={promptPresetBusy || !selectedPromptPresetId}
          >
            Load into all inputs
          </button>
          <button
            type="button"
            className="settings-secondary-btn"
            onClick={() => void deletePromptPreset()}
            disabled={promptPresetBusy || !selectedPromptPresetId}
          >
            Delete
          </button>
        </div>
        {promptPresetStatus ? (
          <p className="settings-learn-status-line settings-learn-status--muted" style={{ marginTop: 7 }}>
            {promptPresetStatus}
          </p>
        ) : null}
      </div>
      ) : null}

      <div 
        className="secret-menu-attach-row"
        style={{ marginTop: 10 }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {sourceImage ? (
          <div className="input-attachment-badge" title={sourceImage.name}>
            <img src={sourceImage.dataUrl} alt="" className="input-attachment-badge-thumb" />
            <button
              type="button"
              className="input-attachment-badge-clear"
              onClick={() => setSourceImage(null)}
              title="Remove reference image"
              aria-label="Remove reference image"
            >
              ×
            </button>
          </div>
        ) : null}
        <input
          type="file"
          id={fieldId('ref-upload')}
          accept="image/*"
          style={{ display: 'none' }}
          onChange={onFileChange}
          disabled={busy}
        />
        <label 
          htmlFor={fieldId('ref-upload')} 
          className={`upload-attachment-btn ${dragOver ? 'upload-attachment-btn--drag-over' : ''}`} 
          title="Face / reference image (required) - drag & drop supported"
        >
          📎 Face photo
        </label>
        {sourceImage && embedded ? (
          <button
            type="button"
            className="settings-secondary-btn"
            onClick={() => saveFaceRef(sourceImage)}
            disabled={busy}
            style={{ marginLeft: 8 }}
            title="Save face reference for later use"
          >
            💾 Save
          </button>
        ) : null}
        {showPoseUpload ? (
          <>
            {poseImage ? (
              <div className="input-attachment-badge" title={poseImage.name}>
                <img src={poseImage.dataUrl} alt="" className="input-attachment-badge-thumb" />
                <button
                  type="button"
                  className="input-attachment-badge-clear"
                  onClick={() => setPoseImage(null)}
                  title="Remove pose reference"
                  aria-label="Remove pose reference"
                >
                  ×
                </button>
              </div>
            ) : null}
            <input
              type="file"
              id={fieldId('pose-upload')}
              accept="image/*"
              style={{ display: 'none' }}
              onChange={onPoseFileChange}
              disabled={busy}
            />
            <label
              htmlFor={fieldId('pose-upload')}
              className="upload-attachment-btn"
              title="Pose reference; a clear full-body person photo works best"
            >
              🕺 Pose photo
            </label>
          </>
        ) : null}
      </div>

      {embedded && storedFaceRefs.length > 0 ? (
        <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
          <p className="settings-desc" style={{ margin: '0 0 8px' }}>
            <strong>Saved face references</strong> — stored encoded in Butler
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {storedFaceRefs.map((ref) => (
              <div
                key={ref.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 10px',
                  background: 'var(--bg-secondary)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border)',
                }}
              >
                <span style={{ fontSize: '0.85em', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ref.name}
                </span>
                <button
                  type="button"
                  className="settings-secondary-btn"
                  onClick={() => loadFaceRef(ref)}
                  disabled={busy}
                  style={{ padding: '2px 8px', fontSize: '0.8em' }}
                  title="Load this face reference"
                >
                  Load
                </button>
                <button
                  type="button"
                  className="settings-secondary-btn"
                  onClick={() => deleteFaceRef(ref.id)}
                  disabled={busy}
                  style={{ padding: '2px 8px', fontSize: '0.8em' }}
                  title="Delete this face reference"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {showPoseControls ? (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <p className="settings-desc" style={{ margin: '0 0 8px' }}>
            <strong>Pose control active</strong> — uses DWPose and a fresh latent so the reference background does not
            override your scene. A real full-body person with visible joints works best; ordinary sketches may not be
            detected.
          </p>
          <label className="settings-desc" htmlFor={fieldId('control-prompt')} style={{ display: 'block' }}>
            CONTROL PROMPT — fixed face/likeness/pose instruction
          </label>
          <textarea
            id={fieldId('control-prompt')}
            className="settings-input"
            value={POSE_CONTROL_BASE_PROMPT}
            rows={3}
            readOnly
            spellCheck={false}
          />
          <label className="settings-desc" htmlFor={fieldId('creative-prompt')} style={{ display: 'block', marginTop: 8 }}>
            THIRD PROMPT — action, outfit, scene, and optional pose changes
          </label>
          <textarea
            id={fieldId('creative-prompt')}
            className="settings-input"
            placeholder="wearing…, in…, raising the left arm higher than the reference…"
            value={easy.creative_prompt}
            onChange={(e) => setField('creative_prompt', e.target.value)}
            rows={4}
            spellCheck={false}
            disabled={busy}
          />
          <label className="settings-desc" htmlFor={fieldId('creative-placement')} style={{ display: 'block', marginTop: 8 }}>
            THIRD PROMPT PLACEMENT
          </label>
          <select
            id={fieldId('creative-placement')}
            className="settings-input"
            value={easy.creative_placement}
            onChange={(e) => setField('creative_placement', e.target.value as CreativePlacement)}
            disabled={busy}
          >
            <option value="append">Append after control prompt</option>
            <option value="prepend">Prepend before control prompt</option>
          </select>
          <label className="settings-desc" htmlFor={fieldId('pose-strength')} style={{ display: 'block', marginTop: 10 }}>
            POSE ADHERENCE — lower allows prompt changes ({easy.pose_strength.toFixed(2)})
          </label>
          <input
            id={fieldId('pose-strength')}
            type="range"
            min={0.35}
            max={1.25}
            step={0.05}
            value={easy.pose_strength}
            onChange={(e) => setField('pose_strength', Number(e.target.value))}
            disabled={busy}
            style={{ width: '100%' }}
          />
          <label className="settings-desc" htmlFor={fieldId('pose-end')} style={{ display: 'block', marginTop: 8 }}>
            POSE CONTROL DURATION — lower gives late steps more freedom ({easy.pose_end_percent.toFixed(2)})
          </label>
          <input
            id={fieldId('pose-end')}
            type="range"
            min={0.35}
            max={1}
            step={0.05}
            value={easy.pose_end_percent}
            onChange={(e) => setField('pose_end_percent', Number(e.target.value))}
            disabled={busy}
            style={{ width: '100%' }}
          />
          <p className="settings-desc" style={{ margin: '6px 0 0' }}>
            For text-driven pose changes, start near strength 0.65 and duration 0.65. For exact copying, use 0.95–1.10
            and 0.80–0.95.
          </p>
          <label className="settings-desc" htmlFor={fieldId('avoid')} style={{ display: 'block', marginTop: 8 }}>
            AVOID — don&apos;t want
          </label>
          <textarea
            id={fieldId('avoid')}
            className="settings-input"
            placeholder="blurry face, wrong outfit…"
            value={easy.avoid}
            onChange={(e) => setField('avoid', e.target.value)}
            rows={2}
            spellCheck={false}
            disabled={busy}
          />
        </div>
      ) : null}

      {showEasyBoxes ? (
        <>
      <label className="settings-desc" htmlFor={fieldId('details')} style={{ display: 'block', marginTop: 12 }}>
        DETAILS — looks (blue eyes…)
      </label>
      <textarea
        id={fieldId('details')}
        className="settings-input"
        placeholder="blue eyes, freckles, long hair…"
        value={easy.details}
        onChange={(e) => setField('details', e.target.value)}
        rows={2}
        spellCheck={false}
        disabled={busy}
      />

      <label className="settings-desc" htmlFor={fieldId('avoid')} style={{ display: 'block', marginTop: 8 }}>
        AVOID — don&apos;t want
      </label>
      <textarea
        id={fieldId('avoid')}
        className="settings-input"
        placeholder="holes in shirt, blurry face…"
        value={easy.avoid}
        onChange={(e) => setField('avoid', e.target.value)}
        rows={2}
        spellCheck={false}
        disabled={busy}
      />

      <label className="settings-desc" htmlFor={fieldId('action')} style={{ display: 'block', marginTop: 8 }}>
        ACTION — what they are doing
      </label>
      <textarea
        id={fieldId('action')}
        className="settings-input"
        placeholder="empty = standing looking at camera"
        value={easy.action}
        onChange={(e) => setField('action', e.target.value)}
        rows={2}
        spellCheck={false}
        disabled={busy}
      />

      <label className="settings-desc" htmlFor={fieldId('pose')} style={{ display: 'block', marginTop: 8 }}>
        POSE — body position
      </label>
      <textarea
        id={fieldId('pose')}
        className="settings-input"
        placeholder="empty = relaxed standing pose"
        value={easy.pose}
        onChange={(e) => setField('pose', e.target.value)}
        rows={2}
        spellCheck={false}
        disabled={busy}
      />

      <label className="settings-desc" htmlFor={fieldId('outfit')} style={{ display: 'block', marginTop: 8 }}>
        OUTFIT — clothes
      </label>
      <textarea
        id={fieldId('outfit')}
        className="settings-input"
        placeholder="empty = stylish casual clothes"
        value={easy.outfit}
        onChange={(e) => setField('outfit', e.target.value)}
        rows={2}
        spellCheck={false}
        disabled={busy}
      />

      <label className="settings-desc" htmlFor={fieldId('scene')} style={{ display: 'block', marginTop: 8 }}>
        SCENE — place / lighting
      </label>
      <textarea
        id={fieldId('scene')}
        className="settings-input"
        placeholder="empty = soft indoor light"
        value={easy.scene}
        onChange={(e) => setField('scene', e.target.value)}
        rows={2}
        spellCheck={false}
        disabled={busy}
      />
        </>
      ) : null}

      {showSweepControls ? (
        <>
      <label className="settings-desc" htmlFor={fieldId('mode')} style={{ display: 'block', marginTop: 10 }}>
        MODE
      </label>
      <select
        id={fieldId('mode')}
        className="settings-input"
        value={easy.mode}
        onChange={(e) => setField('mode', e.target.value as EasyMode)}
        disabled={busy}
      >
        <option value="single">single</option>
        <option value="sweep_winners">sweep_winners</option>
        <option value="sweep_20">sweep_20</option>
      </select>

      <label className="settings-desc" htmlFor={fieldId('sweep-seed')} style={{ display: 'block', marginTop: 8 }}>
        SWEEP_SEED
      </label>
      <input
        id={fieldId('sweep-seed')}
        className="settings-input"
        type="number"
        min={0}
        step={1}
        value={easy.sweep_seed}
        onChange={(e) => setField('sweep_seed', Math.max(0, Math.trunc(Number(e.target.value) || 0)))}
        disabled={busy}
      />
      {easy.mode !== 'single' ? (
        <p className="settings-learn-status-line settings-learn-status--muted" style={{ marginTop: 6 }}>
          This Run generates the preset selected by this seed. Increment the seed for each sequential sweep item; latent
          batch remains 1 to avoid ONNX allocation failures.
        </p>
      ) : null}

      <label className="settings-desc" htmlFor={fieldId('balance')} style={{ display: 'block', marginTop: 10 }}>
        BALANCE — LEFT=face · RIGHT=prompt ({balanceLabel(easy.balance)} · {easy.balance.toFixed(2)})
      </label>
      <input
        id={fieldId('balance')}
        type="range"
        min={-1}
        max={1}
        step={0.05}
        value={easy.balance}
        onChange={(e) => setField('balance', Number(e.target.value))}
        disabled={busy}
        style={{ width: '100%' }}
      />

      <label className="settings-desc" htmlFor={fieldId('framing')} style={{ display: 'block', marginTop: 8 }}>
        Framing
      </label>
      <select
        id={fieldId('framing')}
        className="settings-input"
        value={easy.framing}
        onChange={(e) => setField('framing', e.target.value as Framing)}
        disabled={busy}
      >
        <option value="full_body">full_body</option>
        <option value="waist_up">waist_up</option>
        <option value="medium">medium</option>
        <option value="portrait">portrait</option>
      </select>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 16px', marginTop: 10 }}>
        {(
          [
            ['emphasize_action', 'Emphasize action'],
            ['hands_in_frame', 'Hands in frame'],
            ['frontal_face', 'Frontal face'],
            ['photoreal', 'Photoreal'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="secret-menu-checkbox-row" style={{ margin: 0 }}>
            <input
              type="checkbox"
              checked={easy[key]}
              onChange={(e) => setField(key, e.target.checked)}
              disabled={busy}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>

      <label className="settings-desc" htmlFor={fieldId('preset')} style={{ display: 'block', marginTop: 10 }}>
        PRESET {easy.mode !== 'single' ? '(ignored by sweep mode)' : ''}
      </label>
      <select
        id={fieldId('preset')}
        className="settings-input"
        value={easy.preset}
        onChange={(e) => setField('preset', e.target.value as EasyPreset)}
        disabled={busy}
      >
        {EASY_PRESETS.map((preset) => (
          <option key={preset} value={preset}>
            {preset}
          </option>
        ))}
        {winnerPresets.map((preset) => (
          <option key={preset} value={preset}>
            {preset}
          </option>
        ))}
      </select>

      <div className="secret-menu-prompt-chips-wrap" style={{ marginTop: 10 }}>
        <p className="settings-desc secret-menu-prompt-chips-intro">Snippets → append to ACTION:</p>
        <div className="secret-menu-prompt-chips">
          {SECRET_MENU_NSFW_PROMPT_SNIPPETS.map((s) => (
            <button
              key={s.id}
              type="button"
              className="secret-menu-prompt-chip"
              disabled={busy}
              onClick={() => appendToAction(s.prompt)}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
        </>
      ) : null}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginTop: 12 }}>
        <button type="button" className="settings-save" onClick={() => void generate()} disabled={!canRun}>
          {busy
            ? 'Generating…'
            : studioMode === 'new_scene'
              ? 'Run new scene'
              : poseControlActive
                ? 'Run FaceID + pose control'
                : 'Run easy img2img'}
        </button>
      </div>

      {sweepProgressTotal !== null ? (
        <div style={{ marginTop: 10, width: '100%' }}>
          <div
            style={{
              height: 10,
              width: '100%',
              background: 'var(--border)',
              borderRadius: 999,
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${Math.min(100, ((sweepProgress || 0) / sweepProgressTotal) * 100)}%`,
                background: 'var(--accent)',
                transition: 'width 0.25s ease',
              }}
            />
          </div>
          <p className="settings-desc" style={{ marginTop: 4 }}>
            Sweep progress: {sweepProgress ?? 0}/{sweepProgressTotal}
          </p>
        </div>
      ) : null}

      <div style={{ marginTop: 14 }}>
        <button type="button" className="settings-secondary-btn" onClick={toggleSweepGallery} disabled={sweepBusy}>
          {showSweepGallery ? 'Hide results' : 'View Results'}
        </button>
        {showSweepGallery ? (
          <div style={{ marginTop: 10 }}>
            <p className="settings-desc" style={{ marginTop: 0 }}>
              Decoded Comfy returns in Butler — singles and sweep runs. Click an image for fullscreen.
            </p>
            {outputUrls.length > 0 ? (
              <div style={{ marginBottom: 14 }}>
                <p className="settings-desc secret-menu-prompting-title" style={{ margin: '0 0 8px' }}>
                  This session
                </p>
                <div className="settings-generated-images-grid secret-menu-generated-grid">
                  {outputUrls.map((it, i) => (
                    <figure key={`session-${it.url}-${i}`} className="settings-generated-image-card">
                      <button
                        type="button"
                        className="settings-generated-image-thumb-button"
                        onClick={() => openSingleViewer(i)}
                        title="Open fullscreen viewer"
                        style={{
                          border: 'none',
                          padding: 0,
                          margin: 0,
                          background: 'transparent',
                          cursor: 'pointer',
                          width: '100%',
                          textAlign: 'left',
                        }}
                      >
                        <img
                          src={it.url}
                          alt={it.label || 'Generated image'}
                          className="settings-generated-image-thumb"
                          style={{ width: '100%', height: 'auto' }}
                        />
                      </button>
                      <figcaption className="settings-generated-image-caption">
                        {it.label || `Single ${i + 1}`}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </div>
            ) : null}
            {showSweepControls ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
              <button
                type="button"
                className="settings-secondary-btn"
                onClick={selectNextRun}
                disabled={sweepBusy || runGroups.length <= 1 || viewAllRuns}
              >
                Next run
              </button>
              <button
                type="button"
                className={viewAllRuns ? 'settings-save' : 'settings-secondary-btn'}
                onClick={() => setViewAllRuns((v) => !v)}
                disabled={sweepBusy || runGroups.length === 0}
                title="Show every result from every run in one grid"
              >
                {viewAllRuns ? '✓ All runs' : 'All runs'}
              </button>
              <button
                type="button"
                className="settings-save"
                onClick={() => void saveSweepWinners()}
                disabled={sweepBusy}
              >
                Save selected winners ({winnerDraft.size})
              </button>
              <span className="settings-desc">{sweepStatus}</span>
            </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <button
                  type="button"
                  className="settings-secondary-btn"
                  onClick={() => void loadSweepResults(true)}
                  disabled={sweepBusy}
                >
                  Refresh
                </button>
                <span className="settings-desc">{sweepStatus}</span>
              </div>
            )}
            {showSweepControls && runGroups.length > 1 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                {runGroups.map((run) => (
                  <button
                    key={run.key}
                    type="button"
                    className={run.key === selectedRunKey ? 'settings-save' : 'settings-secondary-btn'}
                    onClick={() => setSelectedRunKey(run.key)}
                    disabled={sweepBusy}
                  >
                    {run.label} ({run.item_count})
                  </button>
                ))}
              </div>
            ) : null}
            {showSweepControls ? (
            <p className="settings-desc" style={{ marginTop: 8 }}>
              Selected images define the presets used by MODE=sweep_winners. Selecting multiple images from one preset
              still counts as one winning preset.
            </p>
            ) : null}
            {sweepProgressTotal !== null ? (
              <div style={{ marginTop: 8, width: '100%' }}>
                <div
                  style={{
                    height: 10,
                    width: '100%',
                    background: 'var(--border)',
                    borderRadius: 999,
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(100, ((sweepProgress || 0) / sweepProgressTotal) * 100)}%`,
                      background: 'var(--accent)',
                      transition: 'width 0.25s ease',
                    }}
                  />
                </div>
                <p className="settings-desc" style={{ marginTop: 4 }}>
                  Sweep progress: {sweepProgress ?? 0}/{sweepProgressTotal}
                </p>
              </div>
            ) : null}
            {sweepItems.length > 0 ? (
              <div className="settings-generated-images-grid secret-menu-generated-grid" style={{ marginTop: 10 }}>
                {sweepItems.map((item, index) => {
                  const selected = winnerDraft.has(item.filename);
                  const isSingle = /_single_/i.test(item.filename);
                  return (
                    <figure
                      key={item.filename}
                      className="settings-generated-image-card"
                      style={selected ? { borderColor: 'var(--accent)', boxShadow: '0 0 0 1px var(--accent)' } : undefined}
                    >
                      {showSweepControls ? (
                      <label className="secret-menu-checkbox-row" style={{ margin: 0 }}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleWinner(item.filename)}
                          disabled={sweepBusy}
                        />
                        <span>
                          {isSingle ? 'Single' : 'Winner'} · {item.preset}
                        </span>
                      </label>
                      ) : (
                        <p className="settings-desc" style={{ margin: '0 0 4px' }}>
                          {isSingle ? 'Single' : 'Sweep'} · {item.preset}
                        </p>
                      )}
                      <button
                        type="button"
                        className="settings-generated-image-thumb-button"
                        onClick={() => openViewer(index)}
                        title="Open fullscreen viewer"
                        style={{
                          border: 'none',
                          padding: 0,
                          margin: 0,
                          background: 'transparent',
                          cursor: 'pointer',
                          width: '100%',
                          textAlign: 'left',
                        }}
                      >
                        <img
                          src={butlerApiUrl(item.image_url)}
                          alt={`${item.preset} result`}
                          className="settings-generated-image-thumb"
                          loading="lazy"
                          style={{ width: '100%', height: 'auto' }}
                        />
                      </button>
                      <figcaption className="settings-generated-image-caption" title={item.filename}>
                        {item.filename}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            ) : (
              <p className="settings-desc" style={{ marginTop: 10 }}>
                {outputUrls.length ? 'No saved disk results yet — session images above.' : 'No results yet. Run a single or sweep, then refresh.'}
              </p>
            )}
          </div>
        ) : null}
      </div>

      {viewerOpen && viewerCount > 0 && viewerItemUrl ? (
        <div
          className="settings-modal-backdrop"
          style={{ zIndex: 10500 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeViewer();
          }}
        >
          <div
            className="settings-modal settings-modal--wide"
            role="dialog"
            aria-modal="true"
            style={
              viewerFullscreen
                ? {
                    maxWidth: '100vw',
                    maxHeight: '100vh',
                    width: '100vw',
                    height: '100vh',
                    borderRadius: 0,
                    margin: 0,
                  }
                : { maxWidth: '96vw', maxHeight: '90vh' }
            }
          >
            <div className="settings-modal-header" style={{ justifyContent: 'space-between', gap: 12 }}>
              <h2 className="settings-modal-title">
                Image viewer {viewerFullscreen ? '(fullscreen)' : ''}
              </h2>
              <div style={{ display: 'flex', gap: 6 }}>
                {viewerSource === 'sweep' && sweepItems[viewerIndex] ? (
                  <button
                    type="button"
                    className="settings-save"
                    onClick={async () => {
                      const item = sweepItems[viewerIndex];
                      if (!item) return;
                      setWinnerDraft((current) => {
                        const next = new Set(current);
                        if (next.has(item.filename)) next.delete(item.filename);
                        else next.add(item.filename);
                        return next;
                      });
                      try {
                        const nextFiles = winnerDraft.has(item.filename)
                          ? [...winnerDraft].filter((f) => f !== item.filename)
                          : [...winnerDraft, item.filename];
                        await fetchButlerJson<{ ok?: boolean; message?: string }>(
                          '/api/sd/img2img/sweep-winners',
                          {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ files: nextFiles }),
                          },
                        );
                      } catch {
                        /* ignore */
                      }
                    }}
                    title={
                      winnerDraft.has(sweepItems[viewerIndex]?.filename)
                        ? 'Remove from winners'
                        : 'Mark as winner preset'
                    }
                    style={{ padding: '2px 10px', fontSize: '0.85em' }}
                  >
                    {winnerDraft.has(sweepItems[viewerIndex]?.filename) ? '★ Saved' : '☆ Save preset'}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="settings-secondary-btn"
                  onClick={() => setViewerFullscreen((v) => !v)}
                  aria-label="Toggle fullscreen"
                  title="Toggle fullscreen (F)"
                  style={{ padding: '2px 10px' }}
                >
                  {viewerFullscreen ? '🗗' : '⛶'}
                </button>
                <button type="button" className="settings-modal-close" onClick={closeViewer} aria-label="Close viewer">
                  ×
                </button>
              </div>
            </div>
            <div
              className="settings-modal-body"
              style={{ display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', padding: '0 0 12px' }}
            >
              <div
                style={{
                  width: '100%',
                  maxWidth: '100%',
                  maxHeight: viewerFullscreen ? 'calc(100vh - 130px)' : 'calc(90vh - 160px)',
                  display: 'flex',
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <img
                  src={viewerItemUrl}
                  alt={viewerItemLabel || `Result ${viewerIndex + 1}`}
                  style={{
                    maxWidth: '100%',
                    maxHeight: '100%',
                    objectFit: 'contain',
                    borderRadius: viewerFullscreen ? 0 : 10,
                    boxShadow: '0 0 0 1px var(--border)',
                  }}
                />
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
                <button
                  type="button"
                  className="settings-secondary-btn"
                  onClick={showPreviousViewer}
                  disabled={viewerCount <= 1}
                >
                  ← Previous
                </button>
                <span className="settings-desc">
                  {viewerIndex + 1} / {viewerCount}
                </span>
                <button
                  type="button"
                  className="settings-secondary-btn"
                  onClick={showNextViewer}
                  disabled={viewerCount <= 1}
                >
                  Next →
                </button>
              </div>
              <div style={{ width: '100%', textAlign: 'center' }}>
                <p className="settings-desc" style={{ margin: '0.25rem 0' }}>
                  {viewerItemLabel}
                </p>
                <p
                  className="settings-learn-status-line settings-learn-status--muted"
                  style={{ margin: '0.25rem 0', fontSize: '0.8em' }}
                >
                  Use ← → arrow keys to navigate · F for fullscreen · Esc to close
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {activityLog.length > 0 ? (
        <pre ref={logRef} className="send-activity-log-body activity-log-modal-pre" style={{ marginTop: 12, maxHeight: 140 }}>
          {activityLog.join('\n')}
        </pre>
      ) : null}
    </div>
  );
}
