import { Billboard, ContactShadows } from '@react-three/drei';
import { Canvas, useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

export type ButlerAvatar3DProps = {
  speaking: boolean;
  voiceActive: boolean;
  layout?: 'header' | 'stage' | 'float';
};

/** Fallback sculpt when /icon.png is missing (dev without `npm run make-icon`). */
function FallbackMascot({ speaking, voiceActive, layout = 'header' }: ButlerAvatar3DProps) {
  const group = useRef<THREE.Group>(null);
  const mouth = useRef<THREE.Mesh>(null);
  const speakBlend = useRef(0);
  const stage = layout === 'stage' || layout === 'float';

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const g = group.current;
    if (g) {
      const amp = voiceActive ? 1 : 0.35;
      const move = stage ? 1.35 : 1;
      g.rotation.y = Math.sin(t * 0.38) * 0.11 * amp * move;
      g.rotation.x = Math.sin(t * 0.22) * 0.045 * amp * move;
      g.rotation.z = speaking ? Math.sin(t * 11) * 0.04 * move : Math.sin(t * 0.9) * 0.02 * amp;
      g.position.y = Math.sin(t * 1.05) * 0.032 * amp * move + (speaking ? Math.sin(t * 18) * 0.018 : 0);
    }

    const target = speaking ? 1 : voiceActive ? 0.22 : 0;
    speakBlend.current += (target - speakBlend.current) * Math.min(1, delta * 6);

    const m = mouth.current;
    if (m) {
      const chatter = speaking ? Math.abs(Math.sin(t * 17.5)) * 0.55 + 0.32 : 0;
      const base = voiceActive && !speaking ? Math.sin(t * 2.8) * 0.05 + 0.08 : 0;
      const open = speakBlend.current * (speaking ? chatter : base + 0.12);
      m.scale.y = 0.1 + open * (stage ? 0.85 : 0.72);
      m.scale.x = 0.28 + open * (stage ? 0.26 : 0.2);
    }
  });

  const rootScale = stage ? 1.55 : 1.08;
  return (
    <group ref={group} scale={rootScale} position={[0, stage ? -0.02 : -0.04, 0]}>
      <mesh position={[0, -0.02, 0]}>
        <sphereGeometry args={[0.4, 48, 40]} />
        <meshStandardMaterial color="#f4e3d7" roughness={0.48} metalness={0.06} />
      </mesh>
      <mesh position={[-0.18, -0.02, 0.3]} scale={[1, 0.55, 0.35]}>
        <sphereGeometry args={[0.09, 20, 20]} />
        <meshStandardMaterial color="#ffffff" roughness={0.35} />
      </mesh>
      <mesh position={[0.18, -0.02, 0.3]} scale={[1, 0.55, 0.35]}>
        <sphereGeometry args={[0.09, 20, 20]} />
        <meshStandardMaterial color="#ffffff" roughness={0.35} />
      </mesh>
      <mesh position={[-0.18, -0.02, 0.36]}>
        <sphereGeometry args={[0.045, 14, 14]} />
        <meshStandardMaterial color="#2a2433" roughness={0.9} />
      </mesh>
      <mesh position={[0.18, -0.02, 0.36]}>
        <sphereGeometry args={[0.045, 14, 14]} />
        <meshStandardMaterial color="#2a2433" roughness={0.9} />
      </mesh>
      <group position={[0, -0.14, 0.29]} rotation={[0.2, 0, 0]}>
        <mesh position={[-0.1, 0, 0]} rotation={[0, 0, 0.35]}>
          <boxGeometry args={[0.16, 0.1, 0.04]} />
          <meshStandardMaterial color="#5a3d7a" roughness={0.45} />
        </mesh>
        <mesh position={[0.1, 0, 0]} rotation={[0, 0, -0.35]}>
          <boxGeometry args={[0.16, 0.1, 0.04]} />
          <meshStandardMaterial color="#5a3d7a" roughness={0.45} />
        </mesh>
        <mesh position={[0, 0, 0.02]}>
          <sphereGeometry args={[0.06, 14, 14]} />
          <meshStandardMaterial color="#4a3268" roughness={0.4} />
        </mesh>
      </group>
      <mesh ref={mouth} position={[0, -0.24, 0.33]}>
        <boxGeometry args={[1, 1, 0.06]} />
        <meshStandardMaterial color="#b86b7a" roughness={0.72} metalness={0} />
      </mesh>
      <group position={[0, 0.38, 0]}>
        <mesh position={[0, 0.12, 0]}>
          <cylinderGeometry args={[0.22, 0.26, 0.38, 28]} />
          <meshStandardMaterial color="#3a3548" roughness={0.65} metalness={0.15} />
        </mesh>
        <mesh position={[0, -0.08, 0]} rotation={[0.08, 0, 0]}>
          <cylinderGeometry args={[0.42, 0.42, 0.05, 36]} />
          <meshStandardMaterial color="#2f2a3d" roughness={0.55} metalness={0.2} />
        </mesh>
        <mesh position={[0, 0.34, 0]}>
          <sphereGeometry args={[0.06, 12, 12]} />
          <meshStandardMaterial color="#9b7fd6" roughness={0.35} metalness={0.25} />
        </mesh>
      </group>
    </group>
  );
}

function IconButlerFace({ speaking, voiceActive, layout = 'header' }: ButlerAvatar3DProps) {
  const root = useRef<THREE.Group>(null);
  const mouth = useRef<THREE.Mesh>(null);
  const speakBlend = useRef(0);
  const [map, setMap] = useState<THREE.Texture | null | undefined>(undefined);
  const stage = layout === 'stage' || layout === 'float';
  const isFloat = layout === 'float';

  useEffect(() => {
    const loader = new THREE.TextureLoader();
    let dead = false;
    loader.load(
      '/icon.png',
      (t) => {
        if (dead) {
          t.dispose();
          return;
        }
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        setMap(t);
      },
      undefined,
      () => {
        if (!dead) setMap(null);
      },
    );
    return () => {
      dead = true;
    };
  }, []);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const g = root.current;
    if (g) {
      const amp = voiceActive ? 1 : 0.4;
      const move = stage ? 1.2 : 1;
      g.rotation.y = Math.sin(t * 0.35) * 0.06 * amp * move;
      g.position.y = Math.sin(t * 0.95) * 0.04 * amp * move + (speaking ? Math.sin(t * 16) * 0.022 : 0);
    }

    const target = speaking ? 1 : voiceActive ? 0.2 : 0;
    speakBlend.current += (target - speakBlend.current) * Math.min(1, delta * 7);

    const m = mouth.current;
    if (m) {
      const chatter = speaking ? Math.abs(Math.sin(t * 18)) * 0.62 + 0.28 : 0;
      const base = voiceActive && !speaking ? Math.sin(t * 2.6) * 0.06 + 0.06 : 0;
      const open = speakBlend.current * (speaking ? chatter : base + 0.1);
      const sy = 0.045 + open * (stage ? 0.95 : 0.78);
      const sx = 0.14 + open * (stage ? 0.2 : 0.16);
      m.scale.set(sx, sy, 0.09);
    }
  });

  if (map === null) {
    return <FallbackMascot speaking={speaking} voiceActive={voiceActive} layout={layout} />;
  }

  if (map === undefined) {
    return null;
  }

  const discR = isFloat ? 0.54 : stage ? 0.62 : 0.42;
  const stageLift = stage ? 0.06 : 0;

  return (
    <group ref={root} position={[0, stageLift, 0]}>
      <Billboard follow lockX={false} lockY={false} lockZ={false}>
        <group>
          <mesh>
            <circleGeometry args={[discR, 72]} />
            <meshStandardMaterial
              map={map}
              transparent
              roughness={0.48}
              metalness={0.06}
              envMapIntensity={0.75}
            />
          </mesh>

          <mesh position={[0, -0.065 * discR * 1.6, 0.038]} rotation={[0.1, 0, 0]}>
            <planeGeometry args={[discR * 0.36, 0.018]} />
            <meshBasicMaterial color="#2a1018" transparent opacity={0.55} depthWrite={false} />
          </mesh>

          <mesh ref={mouth} position={[0, -0.195 * discR * 1.6, 0.035]} rotation={[0.12, 0, 0]}>
            <capsuleGeometry args={[0.055, 0.04, 12, 20]} />
            <meshStandardMaterial color="#9a4a58" roughness={0.72} metalness={0} />
          </mesh>
        </group>
      </Billboard>
    </group>
  );
}

export function ButlerAvatar3D({ speaking, voiceActive, layout = 'header' }: ButlerAvatar3DProps) {
  const stage = layout === 'stage';
  const isFloat = layout === 'float';
  const stageLike = stage || isFloat;
  return (
    <Canvas
      camera={{
        position: [
          0,
          isFloat ? 0.1 : stage ? 0.12 : 0.04,
          isFloat ? 1.38 : stage ? 1.65 : 2.0,
        ],
        fov: isFloat ? 32 : stage ? 30 : 34,
      }}
      gl={{
        alpha: true,
        antialias: true,
        powerPreference: 'high-performance',
      }}
      dpr={[1, 2]}
      style={{ width: '100%', height: '100%', display: 'block' }}
    >
      <ambientLight intensity={stageLike ? 0.55 : 0.5} />
      <hemisphereLight intensity={0.45} color="#e8e4ff" groundColor="#1a1520" />
      <directionalLight position={[3, 4.5, 3.2]} intensity={stageLike ? 1.35 : 1.15} castShadow />
      <directionalLight position={[-3.2, 1.5, 2.2]} intensity={0.55} color="#c4b5fd" />
      <directionalLight position={[0.5, -1.2, 2.8]} intensity={0.22} color="#7dd3fc" />
      <pointLight
        position={[0, 0.35, 1.4]}
        intensity={isFloat ? 0.5 : stage ? 0.55 : 0.42}
        color="#fff8f0"
        distance={4}
        decay={2}
      />
      <spotLight
        position={[0, 1.2, 0.9]}
        angle={0.55}
        penumbra={0.85}
        intensity={isFloat ? 0.28 : stage ? 0.35 : 0.22}
        color="#fef3c7"
        distance={5}
      />

      <IconButlerFace speaking={speaking} voiceActive={voiceActive} layout={layout} />

      {!isFloat && (
        <ContactShadows
          position={[0, stage ? -0.72 : -0.52, 0]}
          opacity={stage ? 0.42 : 0.32}
          scale={stage ? 14 : 10}
          blur={2.8}
          far={3.5}
          color="#0a0610"
        />
      )}
    </Canvas>
  );
}
