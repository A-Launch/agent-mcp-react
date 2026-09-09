// Exercises EVERY subpath the package declares, as an external consumer would reach them.
import { CONNECTION_STATUS, RUNTIME_FAILURE } from 'agent-mcp-react';
import { registerMcpTool } from 'agent-mcp-react/actions';
import { createInspector } from 'agent-mcp-react/devtools';
import { domInspectTools, domInteractTools, invalidateDomRefs } from 'agent-mcp-react/dom';
import { runtimeEvaluateTool } from 'agent-mcp-react/evaluate';
import { bindReduxTool } from 'agent-mcp-react/redux';
import { bindNavigationTool, bindUrlFilterTool } from 'agent-mcp-react/router';
import { createAjvValidator } from 'agent-mcp-react/validation';
import { bindZustandTool } from 'agent-mcp-react/zustand';

export const surface = {
  RUNTIME_FAILURE,
  CONNECTION_STATUS,
  createAjvValidator,
  registerMcpTool,
  domInspectTools,
  domInteractTools,
  invalidateDomRefs,
  runtimeEvaluateTool,
  createInspector,
  bindReduxTool,
  bindZustandTool,
  bindNavigationTool,
  bindUrlFilterTool,
};
