import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { fetchButlerJson, fetchButlerJsonWithResponse } from '../lib/fetchButlerJson';

type SeoTab = 'auth' | 'plan' | 'playlists' | 'schedule';

type ProposedTrack = {
  position?: number;
  uri?: string;
  name?: string;
  artists?: string;
  popularity?: number;
  role?: string;
};

type Plan = {
  focus_track?: {
    name?: string;
    uri?: string;
    artist_names?: string[];
    popularity?: number;
    external_url?: string;
  };
  niche?: string;
  mood?: string;
  activity?: string;
  keywords?: string[];
  similar_artists?: string[];
  name?: string;
  description?: string;
  playlist_size?: number;
  your_track_ratio?: number;
  market?: string;
  track_uris?: string[];
  proposed_tracks?: ProposedTrack[];
  anchor_count?: number;
  your_count?: number;
  artist_name?: string;
  rationale?: string;
};

type PlaylistRow = {
  id?: string;
  name?: string;
  url?: string;
  niche?: string;
  track_count?: number;
  last_maintained?: string;
  focus_track_uri?: string;
};

type Schedule = {
  enabled?: boolean;
  interval_days?: number;
  last_run?: string | null;
  next_due?: string | null;
  market?: string;
  add_fresh_tracks?: boolean;
  refresh_copy?: boolean;
  ensure_your_tracks?: boolean;
};

function splitCsv(s: string): string[] {
  return s
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function SpotifySeoPanel() {
  const [tab, setTab] = useState<SeoTab>('auth');
  const [statusMsg, setStatusMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState<boolean | null>(null);
  const [spotifyUser, setSpotifyUser] = useState('');
  const [hasClientId, setHasClientId] = useState<boolean | null>(null);
  const [artistName, setArtistName] = useState('');
  const [authorizeUrl, setAuthorizeUrl] = useState('');
  const [redirectUri, setRedirectUri] = useState('http://127.0.0.1:4389/callback');
  const [oauthCode, setOauthCode] = useState('');
  const [oauthState, setOauthState] = useState('');

  // Plan form
  const [focusTrack, setFocusTrack] = useState('');
  const [niche, setNiche] = useState('');
  const [mood, setMood] = useState('');
  const [activity, setActivity] = useState('');
  const [keywords, setKeywords] = useState('');
  const [similar, setSimilar] = useState('');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [playlistSize, setPlaylistSize] = useState(50);
  const [yourRatio, setYourRatio] = useState(0.12);
  const [market, setMarket] = useState('US');
  const [plan, setPlan] = useState<Plan | null>(null);

  const [playlists, setPlaylists] = useState<PlaylistRow[]>([]);
  const [schedule, setSchedule] = useState<Schedule>({
    enabled: false,
    interval_days: 7,
    add_fresh_tracks: true,
    refresh_copy: true,
    ensure_your_tracks: true,
    market: 'US',
  });

  const refreshMeta = useCallback(async () => {
    try {
      const [st, pl, sch, art] = await Promise.all([
        fetchButlerJson<{
          ok?: boolean;
          connected?: boolean;
          display_name?: string;
          has_client_id?: boolean;
          message?: string;
        }>('/api/spotify/status'),
        fetchButlerJson<{ playlists?: PlaylistRow[] }>('/api/spotify/playlists'),
        fetchButlerJson<{ schedule?: Schedule }>('/api/spotify/seo/schedule'),
        fetchButlerJson<{
          project?: {
            artist_name?: string;
            genres?: string[];
            seo_niches?: string[];
            similar_artists?: string[];
            moods?: string[];
          };
        }>('/api/artist/project'),
      ]);
      setConnected(!!st.connected);
      setSpotifyUser(st.display_name || '');
      setHasClientId(st.has_client_id !== false);
      setPlaylists(pl.playlists || []);
      if (sch.schedule) setSchedule((prev) => ({ ...prev, ...sch.schedule }));
      const proj = art.project || {};
      if (proj.artist_name) setArtistName(proj.artist_name);
      if (!niche && proj.seo_niches?.[0]) setNiche(proj.seo_niches[0]);
      else if (!niche && proj.genres?.[0]) setNiche(proj.genres[0]);
      if (!mood && proj.moods?.[0]) setMood(proj.moods[0]);
      if (!similar && proj.similar_artists?.length) setSimilar(proj.similar_artists.slice(0, 8).join(', '));
      if (!keywords && proj.seo_niches?.length) setKeywords(proj.seo_niches.slice(0, 8).join(', '));
      if (!st.connected && st.message) setStatusMsg(st.message);
    } catch (e) {
      setConnected(false);
      setStatusMsg(String((e as Error)?.message || e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hydrate once from server
  }, []);

  useEffect(() => {
    void refreshMeta();
  }, [refreshMeta]);

  const parseCodeInput = (raw: string) => {
    const t = raw.trim();
    if (!t) return { code: '', state: '' };
    try {
      if (t.includes('code=')) {
        const u = new URL(t.includes('://') ? t : `http://local/?${t.replace(/^\?/, '')}`);
        return {
          code: u.searchParams.get('code') || '',
          state: u.searchParams.get('state') || '',
        };
      }
    } catch {
      /* plain code */
    }
    return { code: t, state: oauthState };
  };

  const onStartOauth = async () => {
    setBusy(true);
    setStatusMsg('Starting Spotify OAuth…');
    try {
      const { data } = await fetchButlerJsonWithResponse<{
        ok?: boolean;
        message?: string;
        authorize_url?: string;
        redirect_uri?: string;
      }>('/api/spotify/oauth/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!data.ok || !data.authorize_url) {
        setStatusMsg(data.message || 'Could not start OAuth — set SPOTIFY_CLIENT_ID / SECRET in .env');
        return;
      }
      setAuthorizeUrl(data.authorize_url);
      if (data.redirect_uri) setRedirectUri(data.redirect_uri);
      try {
        window.open(data.authorize_url, '_blank', 'noopener,noreferrer');
      } catch {
        /* user can open manually */
      }
      setTab('auth');
      setStatusMsg(
        'Browser opened for Spotify approval. After you allow access, copy the redirect URL (or just the code= value) into the field below and click Finish connect.',
      );
    } catch (e) {
      setStatusMsg(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const onFinishOauth = async () => {
    const parsed = parseCodeInput(oauthCode);
    if (!parsed.code) {
      setStatusMsg('Paste the authorization code or full redirect URL from Spotify.');
      return;
    }
    setBusy(true);
    setStatusMsg('Finishing Spotify connect…');
    try {
      const { data } = await fetchButlerJsonWithResponse<{
        ok?: boolean;
        message?: string;
        display_name?: string;
      }>('/api/spotify/oauth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: parsed.code,
          state: parsed.state || oauthState || undefined,
        }),
      });
      setStatusMsg(data.message || (data.ok ? 'Connected' : 'Auth failed'));
      if (data.ok) {
        setOauthCode('');
        setAuthorizeUrl('');
        await refreshMeta();
        setTab('plan');
      }
    } catch (e) {
      setStatusMsg(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };
  const planBody = () => ({
    focus_track: focusTrack.trim(),
    niche: niche.trim(),
    mood: mood.trim(),
    activity: activity.trim(),
    keywords: splitCsv(keywords),
    similar_artists: splitCsv(similar),
    name: title.trim() || undefined,
    description: description.trim() || undefined,
    playlist_size: playlistSize,
    your_track_ratio: yourRatio,
    market,
  });

  const onPlan = async () => {
    if (!focusTrack.trim()) {
      setStatusMsg('Paste your song’s Spotify URI, URL, or track ID first.');
      return;
    }
    setBusy(true);
    setStatusMsg('Planning SEO playlist from song + artist profile…');
    try {
      const { data } = await fetchButlerJsonWithResponse<{ ok?: boolean; message?: string; plan?: Plan }>(
        '/api/spotify/seo/plan',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(planBody()),
        },
      );
      if (!data.ok || !data.plan) {
        setStatusMsg(data.message || 'Plan failed');
        setPlan(null);
        return;
      }
      setPlan(data.plan);
      setTitle(data.plan.name || '');
      setDescription(data.plan.description || '');
      setNiche(data.plan.niche || niche);
      setMood(data.plan.mood || mood);
      setActivity(data.plan.activity || activity);
      if (data.plan.keywords?.length) setKeywords(data.plan.keywords.join(', '));
      if (data.plan.similar_artists?.length) setSimilar(data.plan.similar_artists.join(', '));
      setStatusMsg(data.message || 'Plan ready — review title/description/tracks, then Create.');
    } catch (e) {
      setStatusMsg(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const onCreate = async (dryRun: boolean) => {
    if (!focusTrack.trim()) {
      setStatusMsg('Focus song required.');
      return;
    }
    setBusy(true);
    setStatusMsg(dryRun ? 'Dry-run create…' : 'Creating playlist on Spotify…');
    try {
      const body = {
        ...planBody(),
        dry_run: dryRun,
        plan: plan || undefined,
      };
      const { data } = await fetchButlerJsonWithResponse<{
        ok?: boolean;
        message?: string;
        playlist?: { url?: string };
        plan?: Plan;
      }>('/api/spotify/seo/create-from-song', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setStatusMsg(
        (data.message || (data.ok ? 'Done' : 'Failed')) +
          (data.playlist?.url ? ` → ${data.playlist.url}` : ''),
      );
      if (data.plan) setPlan(data.plan);
      if (data.ok && !dryRun) await refreshMeta();
    } catch (e) {
      setStatusMsg(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const onSaveSchedule = async () => {
    setBusy(true);
    try {
      const { data } = await fetchButlerJsonWithResponse<{ ok?: boolean; message?: string; schedule?: Schedule }>(
        '/api/spotify/seo/schedule',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: !!schedule.enabled,
            interval_days: schedule.interval_days ?? 7,
            market: schedule.market || market,
            add_fresh_tracks: !!schedule.add_fresh_tracks,
            refresh_copy: !!schedule.refresh_copy,
            ensure_your_tracks: !!schedule.ensure_your_tracks,
          }),
        },
      );
      if (data.schedule) setSchedule(data.schedule);
      setStatusMsg(data.message || 'Schedule saved');
    } catch (e) {
      setStatusMsg(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const onRunWeekly = async () => {
    setBusy(true);
    setStatusMsg('Running weekly maintain now…');
    try {
      const { data } = await fetchButlerJsonWithResponse<{ ok?: boolean; message?: string; schedule?: Schedule }>(
        '/api/spotify/seo/schedule',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ run_now: true, market: schedule.market || market }),
        },
      );
      if (data.schedule) setSchedule(data.schedule);
      setStatusMsg(data.message || 'Weekly maintain finished');
      await refreshMeta();
    } catch (e) {
      setStatusMsg(String((e as Error)?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const field = (label: string, hint: string, node: ReactNode) => (
    <label className="agent-window-api-key-field" style={{ display: 'block', marginBottom: 10 }}>
      <span className="agent-window-api-key-label">{label}</span>
      {hint ? <span className="agent-settings-note" style={{ display: 'block', margin: '2px 0 6px' }}>{hint}</span> : null}
      {node}
    </label>
  );

  return (
    <div className="spotify-seo-panel">
      <p className="agent-settings-note">
        Song-first Spotify SEO for <strong>{artistName || 'your artist profile'}</strong>. Connect Spotify on the Connect
        tab, then plan playlists around a focus track.
        {connected === null ? '' : connected ? ` Spotify: connected${spotifyUser ? ` (${spotifyUser})` : ''}.` : ' Spotify: not connected.'}
      </p>

      <div className="secret-menu-image-studio-tabs" role="tablist" aria-label="Spotify SEO" style={{ marginBottom: 12 }}>
        {(
          [
            ['auth', 'Connect'],
            ['plan', 'Plan & create'],
            ['playlists', 'Playlists'],
            ['schedule', 'Weekly'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'secret-menu-image-studio-tabs--active' : undefined}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'auth' && (
        <div>
          <p className="agent-settings-note">
            Status:{' '}
            {connected === null
              ? 'checking…'
              : connected
                ? `Connected${spotifyUser ? ` as ${spotifyUser}` : ''}`
                : 'Not connected'}
            {hasClientId === false ? ' — add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env first.' : ''}
          </p>
          <ol className="agent-settings-note" style={{ paddingLeft: 18 }}>
            <li>
              Create an app at{' '}
              <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noreferrer">
                developer.spotify.com/dashboard
              </a>
            </li>
            <li>
              Add Redirect URI exactly: <code>{redirectUri}</code>
            </li>
            <li>Put Client ID + Secret in repo <code>.env</code>, restart Butler</li>
            <li>Click Connect with Spotify, approve, then paste the redirect URL / code below</li>
          </ol>
          <div className="jobs-resume-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            <button type="button" className="agent-window-btn" disabled={busy} onClick={() => void onStartOauth()}>
              {connected ? 'Re-connect Spotify' : 'Connect with Spotify'}
            </button>
            {authorizeUrl ? (
              <a className="settings-secondary-btn" href={authorizeUrl} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', padding: '6px 12px' }}>
                Open auth link again
              </a>
            ) : null}
            <button type="button" className="settings-secondary-btn" disabled={busy} onClick={() => void refreshMeta()}>
              Refresh status
            </button>
          </div>
          {field(
            'Authorization code or redirect URL',
            'After approve, the browser may show a failed page on 127.0.0.1:4389 — copy the full address bar URL here',
            <textarea
              className="settings-input"
              rows={3}
              value={oauthCode}
              onChange={(e) => {
                setOauthCode(e.target.value);
                const p = parseCodeInput(e.target.value);
                if (p.state) setOauthState(p.state);
              }}
              disabled={busy}
              placeholder="http://127.0.0.1:4389/callback?code=…&state=…  or  code only"
            />,
          )}
          <button type="button" className="agent-window-btn" disabled={busy || !oauthCode.trim()} onClick={() => void onFinishOauth()}>
            Finish connect
          </button>
          <p className="agent-settings-note" style={{ marginTop: 10 }}>
            CLI alternative: <code>npm run spotify:oauth</code> (local callback server).
          </p>
        </div>
      )}

      {tab === 'plan' && (
        <div>
          {field(
            'Focus song (required)',
            'Spotify track URI, open.spotify.com/track/… URL, or 22-char ID',
            <input
              className="agent-window-api-key-input settings-input"
              value={focusTrack}
              onChange={(e) => setFocusTrack(e.target.value)}
              placeholder="spotify:track:… or https://open.spotify.com/track/…"
              disabled={busy}
            />,
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {field(
              'Primary niche / keyword',
              'Front-loaded in title (genre people search)',
              <input className="settings-input" value={niche} onChange={(e) => setNiche(e.target.value)} disabled={busy} placeholder="drum and bass" />,
            )}
            {field(
              'Mood',
              'Optional second keyword',
              <input className="settings-input" value={mood} onChange={(e) => setMood(e.target.value)} disabled={busy} placeholder="dark / liquid / festival" />,
            )}
            {field(
              'Activity',
              'Use-case listeners search for',
              <input className="settings-input" value={activity} onChange={(e) => setActivity(e.target.value)} disabled={busy} placeholder="club / focus / workout" />,
            )}
            {field(
              'Market',
              'Spotify market for popularity',
              <input className="settings-input" value={market} onChange={(e) => setMarket(e.target.value)} disabled={busy} />,
            )}
          </div>
          {field(
            'Secondary keywords',
            'Comma-separated — woven into description (5–7 ideal)',
            <textarea
              className="settings-input"
              rows={2}
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              disabled={busy}
            />,
          )}
          {field(
            'Similar / anchor artists',
            'High-traction artists in your lane (from profile/FORMA; edit freely)',
            <textarea className="settings-input" rows={2} value={similar} onChange={(e) => setSimilar(e.target.value)} disabled={busy} />,
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {field(
              'Playlist size',
              '40–100 optimal for retention',
              <input
                className="settings-input"
                type="number"
                min={20}
                max={100}
                value={playlistSize}
                onChange={(e) => setPlaylistSize(Number(e.target.value) || 50)}
                disabled={busy}
              />,
            )}
            {field(
              'Your-track ratio',
              '~0.10–0.15 keeps authenticity + SEO anchors',
              <input
                className="settings-input"
                type="number"
                step={0.01}
                min={0.05}
                max={0.25}
                value={yourRatio}
                onChange={(e) => setYourRatio(Number(e.target.value) || 0.12)}
                disabled={busy}
              />,
            )}
          </div>
          {field(
            'Playlist title (override)',
            'Leave blank to auto-craft; keep ≤40 chars, keywords first',
            <input className="settings-input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={busy} />,
          )}
          {field(
            'Description (override)',
            '100–300 chars; primary keyword first; end with weekly update note',
            <textarea className="settings-input" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} disabled={busy} />,
          )}

          <div className="jobs-resume-actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8 }}>
            <button type="button" className="agent-window-btn" disabled={busy} onClick={() => void onPlan()}>
              Plan from song
            </button>
            <button type="button" className="settings-secondary-btn" disabled={busy || !plan} onClick={() => void onCreate(true)}>
              Dry-run create
            </button>
            <button type="button" className="agent-window-btn" disabled={busy || !plan} onClick={() => void onCreate(false)}>
              Create on Spotify
            </button>
            <button type="button" className="settings-secondary-btn" disabled={busy} onClick={() => void refreshMeta()}>
              Refresh status
            </button>
          </div>

          {plan && (
            <div className="agent-settings-note" style={{ marginTop: 14 }}>
              <strong>Plan preview</strong>
              <div style={{ marginTop: 6 }}>
                Focus: {plan.focus_track?.name} — {(plan.focus_track?.artist_names || []).join(', ')}{' '}
                (pop {plan.focus_track?.popularity ?? '—'})
              </div>
              <div>
                Title: {plan.name} · {plan.your_count} yours / {plan.anchor_count} anchors · size {plan.playlist_size}
              </div>
              <div style={{ marginTop: 4 }}>{plan.description}</div>
              {plan.rationale ? <div style={{ marginTop: 6, opacity: 0.85 }}>{plan.rationale}</div> : null}
              {plan.proposed_tracks?.length ? (
                <ol style={{ margin: '8px 0 0', paddingLeft: 18, maxHeight: 220, overflow: 'auto' }}>
                  {plan.proposed_tracks.slice(0, 25).map((t) => (
                    <li key={`${t.position}-${t.uri}`}>
                      <span style={{ opacity: 0.7 }}>[{t.role}]</span> {t.name || t.uri}
                      {t.artists ? ` — ${t.artists}` : ''}
                      {typeof t.popularity === 'number' ? ` · ${t.popularity}` : ''}
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
          )}
        </div>
      )}

      {tab === 'playlists' && (
        <div>
          <p className="agent-settings-note">Registered SEO playlists Butler maintains.</p>
          {playlists.length === 0 ? (
            <p className="agent-settings-note">None yet — create one from the Plan tab.</p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {playlists.map((p) => (
                <li key={p.id || p.url} style={{ marginBottom: 8 }}>
                  <strong>{p.name || p.id}</strong>
                  {p.niche ? ` · ${p.niche}` : ''}
                  {typeof p.track_count === 'number' ? ` · ${p.track_count} tracks` : ''}
                  {p.last_maintained ? ` · maintained ${p.last_maintained.slice(0, 10)}` : ''}
                  {p.url ? (
                    <>
                      {' '}
                      <a href={p.url} target="_blank" rel="noreferrer">
                        open
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="settings-secondary-btn"
            style={{ marginTop: 10 }}
            disabled={busy}
            onClick={() => void onRunWeekly()}
          >
            Maintain all now
          </button>
        </div>
      )}

      {tab === 'schedule' && (
        <div>
          <p className="agent-settings-note">
            Knowledge API checks hourly. When due, it refreshes titles/descriptions, ensures your tracks stay well
            placed, and prepends 2–5 fresh high-traction niche songs (signals “active playlist” to Spotify search).
          </p>
          <label className="agent-settings-toggle" style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={!!schedule.enabled}
              onChange={(e) => setSchedule((s) => ({ ...s, enabled: e.target.checked }))}
              disabled={busy}
            />
            <span>
              <strong>Enable weekly auto-maintain</strong>
              <span className="agent-settings-toggle-hint">Runs in the background while Knowledge API is up.</span>
            </span>
          </label>
          {field(
            'Interval (days)',
            'Default 7',
            <input
              className="settings-input"
              type="number"
              min={1}
              max={30}
              value={schedule.interval_days ?? 7}
              onChange={(e) => setSchedule((s) => ({ ...s, interval_days: Number(e.target.value) || 7 }))}
              disabled={busy}
            />,
          )}
          <label className="agent-settings-toggle" style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={!!schedule.add_fresh_tracks}
              onChange={(e) => setSchedule((s) => ({ ...s, add_fresh_tracks: e.target.checked }))}
              disabled={busy}
            />
            <span>Add fresh high-traction tracks each run</span>
          </label>
          <label className="agent-settings-toggle" style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            <input
              type="checkbox"
              checked={!!schedule.refresh_copy}
              onChange={(e) => setSchedule((s) => ({ ...s, refresh_copy: e.target.checked }))}
              disabled={busy}
            />
            <span>Refresh SEO title / description</span>
          </label>
          <label className="agent-settings-toggle" style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={!!schedule.ensure_your_tracks}
              onChange={(e) => setSchedule((s) => ({ ...s, ensure_your_tracks: e.target.checked }))}
              disabled={busy}
            />
            <span>Keep your tracks well placed</span>
          </label>
          <div className="agent-settings-note" style={{ marginBottom: 8 }}>
            Last run: {schedule.last_run || 'never'} · Next due: {schedule.next_due || '—'}
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="agent-window-btn" disabled={busy} onClick={() => void onSaveSchedule()}>
              Save schedule
            </button>
            <button type="button" className="settings-secondary-btn" disabled={busy} onClick={() => void onRunWeekly()}>
              Run weekly maintain now
            </button>
          </div>
        </div>
      )}

      {statusMsg ? (
        <p className="agent-settings-note" style={{ marginTop: 12, whiteSpace: 'pre-wrap' }}>
          {statusMsg}
        </p>
      ) : null}
    </div>
  );
}
