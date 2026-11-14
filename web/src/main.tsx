import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { loadCore } from './core';
import { AgentPanel } from './agent/AgentPanel';
import { registerAgent } from './agent/port';
import { rulesAgent } from './agent/rules';
import { pirsAgent } from './agent/pirs';
import { registerAgentTools } from './agent/tools';
import './styles.css';

// #11 question panel: agents and tools (window.__walkback lets an outside harness add its own agent).
registerAgent(rulesAgent);
registerAgent(pirsAgent);
loadCore().then(registerAgentTools, () => undefined);

createRoot(document.getElementById('root')!).render(<StrictMode><App /><AgentPanel /></StrictMode>);
