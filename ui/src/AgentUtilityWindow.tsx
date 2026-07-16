import { useCallback, useEffect } from 'react';
import {
  AgentUtilityPanel,
  type AgentUtilitySideAttachment,
} from './components/AgentUtilityPanel';

/**
 * Detached OS window for the secret utility / image studio (#agent-utility).
 * Opened via Q+W+E + far-left logo; closed with the window chrome or Close.
 */
export function AgentUtilityWindow() {
  useEffect(() => {
    document.documentElement.classList.add('butler-utility-root');
    document.title = 'Butler Utility';
    return () => {
      document.documentElement.classList.remove('butler-utility-root');
    };
  }, []);

  const onClose = useCallback(() => {
    if (window.butlerElectron?.closeAgentUtility) {
      void window.butlerElectron.closeAgentUtility();
      return;
    }
    window.close();
  }, []);

  const onSideSend = useCallback(
    async (message: string, attachment?: AgentUtilitySideAttachment | null) => {
      if (window.butlerElectron?.sendAgentUtilitySideMessage) {
        await window.butlerElectron.sendAgentUtilitySideMessage({ message, attachment: attachment ?? null });
        return;
      }
      // Non-Electron fallback: nothing to forward
      console.warn('[Butler Utility] side send requires Electron Agent window');
    },
    [],
  );

  return (
    <AgentUtilityPanel open onClose={onClose} onSideSend={onSideSend} variant="window" />
  );
}
