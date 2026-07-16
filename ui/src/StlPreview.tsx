import { useEffect, useMemo, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import * as THREE from 'three';

function PreviewMesh({ geometry }: { geometry: THREE.BufferGeometry }) {
  const scale = useMemo(() => {
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    const r = geometry.boundingSphere?.radius || 1;
    return 44 / Math.max(r, 0.001);
  }, [geometry]);

  return (
    <mesh geometry={geometry} scale={scale}>
      <meshStandardMaterial color="#e8a060" metalness={0.22} roughness={0.46} />
    </mesh>
  );
}

export function StlPreview({ url, filename }: { url: string; filename: string }) {
  const [geometry, setGeometry] = useState<THREE.BufferGeometry | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let loaded: THREE.BufferGeometry | null = null;
    setError(null);
    setGeometry(null);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then((buf) => {
        const loader = new STLLoader();
        const geom = loader.parse(buf) as THREE.BufferGeometry;
        geom.computeVertexNormals();
        geom.center();
        loaded = geom;
        if (cancelled) {
          geom.dispose();
          loaded = null;
          return;
        }
        setGeometry(geom);
      })
      .catch(() => {
        if (!cancelled) setError('Could not load preview');
      });
    return () => {
      cancelled = true;
      loaded?.dispose();
    };
  }, [url]);

  return (
    <div className="chat-stl-preview">
      <div className="chat-stl-preview__label" title={filename}>
        3D preview · <span className="chat-stl-preview__fname">{filename}</span>
      </div>
      {error ? <div className="chat-stl-preview__error">{error}</div> : null}
      {!error && geometry ? (
        <div className="chat-stl-preview__canvas">
          <Canvas
            gl={{ antialias: true, alpha: true }}
            camera={{ position: [0, 0, 88], fov: 42 }}
            style={{ width: '100%', height: '100%', touchAction: 'none' }}
          >
            <ambientLight intensity={0.72} />
            <directionalLight position={[14, 24, 18]} intensity={1.05} />
            <directionalLight position={[-10, -8, -6]} intensity={0.35} />
            <PreviewMesh geometry={geometry} />
            <OrbitControls makeDefault enableDamping dampingFactor={0.08} />
          </Canvas>
        </div>
      ) : null}
      {!error && !geometry ? <div className="chat-stl-preview__loading">Loading mesh…</div> : null}
    </div>
  );
}
