export {};

declare global {
  interface Window {
    butlerElectron?: {
      openButlerFloat: () => Promise<void>;
      closeButlerFloat: () => Promise<void>;
      hideButlerFloat: () => Promise<void>;
      openButlerAgent: () => Promise<void>;
      popOutButlerAgent: () => Promise<void>;
      popInButlerAgent: () => Promise<void>;
      openAgentUtility: () => Promise<void>;
      closeAgentUtility: () => Promise<void>;
      sendAgentUtilitySideMessage: (payload: {
        message: string;
        attachment?: {
          dataUrl: string;
          name: string;
          mime: string;
        } | null;
      }) => Promise<{ ok?: boolean; error?: string }>;
      onAgentUtilitySideSend: (
        cb: (payload: {
          message: string;
          attachment?: {
            dataUrl: string;
            name: string;
            mime: string;
          } | null;
        }) => void,
      ) => () => void;
      openExternalUrl: (url: string) => Promise<{ ok?: boolean; error?: string }>;
      pickAgentFolder: (defaultPath?: string) => Promise<{ ok?: boolean; path?: string; error?: string }>;
      openAgentExplorer: (targetPath: string) => Promise<{ ok?: boolean; path?: string; error?: string }>;
      beginButlerDockFlyFromFloat: () => Promise<void>;
      syncButlerFloat: (s: {
        speaking: boolean;
        voiceActive: boolean;
        userSpeaking?: boolean;
        heardPreview?: string | null;
        voicePaused?: boolean;
        micMuted?: boolean;
      }) => void;
      onButlerFloatDocked: (cb: () => void) => () => void;
      onVoiceMicToggle: (cb: () => void) => () => void;
      onButlerFloatDockFly: (
        cb: (p: { fromX: number; fromY: number; spherePx?: number } | null | undefined) => void,
      ) => () => void;
    };
    butlerFloat?: {
      onState: (
        cb: (s: {
          speaking: boolean;
          voiceActive: boolean;
          userSpeaking?: boolean;
          heardPreview?: string | null;
          voicePaused?: boolean;
          micMuted?: boolean;
        }) => void,
      ) => () => void;
      hide: () => void;
      toggleMicMute?: () => void;
    };
  }
}
