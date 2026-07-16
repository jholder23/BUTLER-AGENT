import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { AgentWindow } from './AgentWindow';
import { AgentUtilityWindow } from './AgentUtilityWindow';
import { ButlerFloatWindow } from './ButlerFloatWindow';
import './styles.css';
import './agent-facelift.css';

const hash =
  typeof window !== 'undefined' ? window.location.hash.replace(/^#/, '').split('&')[0] : '';

const isFloatButler = hash === 'float-butler';
const isAgentStandalone = hash === 'agent-standalone';
const isAgentUtility = hash === 'agent-utility';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    {isFloatButler ? (
      <ButlerFloatWindow />
    ) : isAgentUtility ? (
      <AgentUtilityWindow />
    ) : isAgentStandalone ? (
      <AgentWindow standalone />
    ) : (
      <App />
    )}
  </React.StrictMode>,
);
