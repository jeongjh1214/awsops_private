export type PrivateAgentProvider = 'agentcore' | 'local-mcp-langgraph' | string | undefined;

export interface PrivateAiRouteLike {
  handler?: string;
  gateway?: string;
}

export interface PrivateBedrockConfigLike {
  activeEnvironment?: string;
  environments?: Record<string, {
    endpointMode?: string;
    bedrockProfile?: string;
    endpointUrls?: Record<string, string>;
  }>;
  agent?: {
    modelId?: string;
  };
}

const NEXT_PRIVATE_HANDLERS = new Set(['sql', 'datasource', 'auto-collect']);
const LEGACY_DEFAULT_MODEL_ID = 'anthropic.claude-sonnet-4-6';

export function shouldDelegateRouteToLocalPrivateAgent(
  provider: PrivateAgentProvider,
  route: PrivateAiRouteLike | undefined,
): boolean {
  if (provider !== 'local-mcp-langgraph') return false;
  return !route?.handler || !NEXT_PRIVATE_HANDLERS.has(route.handler);
}

export function getPrivateBedrockRuntimeContext(config: PrivateBedrockConfigLike): {
  activeEnvironment: string;
  profile?: string;
  endpointMode?: string;
  endpointUrl?: string;
  modelId?: string;
} {
  const activeEnvironment = config.activeEnvironment || 'dev';
  const environment = config.environments?.[activeEnvironment];
  const endpointUrl = environment?.endpointMode === 'privateDns'
    ? undefined
    : environment?.endpointUrls?.['bedrock-runtime'];

  return {
    activeEnvironment,
    profile: environment?.bedrockProfile || undefined,
    endpointMode: environment?.endpointMode,
    endpointUrl,
    modelId: config.agent?.modelId,
  };
}

export function resolvePrivateBedrockModelId(
  configuredModelId: string | undefined,
  requestedModelKey: string | undefined,
  modelAliases: Record<string, string>,
  fallbackModelKey: string,
): string {
  const configured = (configuredModelId || '').trim();
  if (configured && configured !== LEGACY_DEFAULT_MODEL_ID) {
    return modelAliases[configured] || configured;
  }

  const requested = (requestedModelKey || '').trim() || fallbackModelKey;
  return modelAliases[requested] || requested;
}
