import { SignJWT, jwtVerify } from 'jose';
import { getPrivateRuntimeConfig } from './private-runtime-config';
import type { User } from './auth';

const LOCAL_TOKEN_PREFIX = 'local.';
const LOCAL_ISSUER = 'awsops-local-auth';
const LOCAL_AUDIENCE = 'awsops-local';
const LOCAL_EXPIRES_IN = 12 * 60 * 60;

interface LocalAuthSettings {
  email: string;
  password: string;
  groups: string[];
  secret: Uint8Array;
}

export async function authenticateLocalUser(
  email: string,
  password: string,
): Promise<{ idToken: string; expiresIn: number } | null> {
  const settings = getLocalAuthSettings();
  if (!settings) return null;
  if (email.trim().toLowerCase() !== settings.email.toLowerCase()) return null;
  if (password !== settings.password) return null;

  const token = await new SignJWT({
    token_use: 'id',
    email: settings.email,
    'cognito:groups': settings.groups,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(LOCAL_ISSUER)
    .setAudience(LOCAL_AUDIENCE)
    .setSubject(`local:${settings.email}`)
    .setIssuedAt()
    .setExpirationTime(`${LOCAL_EXPIRES_IN}s`)
    .sign(settings.secret);

  return { idToken: `${LOCAL_TOKEN_PREFIX}${token}`, expiresIn: LOCAL_EXPIRES_IN };
}

export async function verifyLocalUserToken(token: string): Promise<User | null> {
  if (!token.startsWith(LOCAL_TOKEN_PREFIX)) return null;
  const settings = getLocalAuthSettings();
  if (!settings) return null;

  try {
    const { payload } = await jwtVerify(token.slice(LOCAL_TOKEN_PREFIX.length), settings.secret, {
      issuer: LOCAL_ISSUER,
      audience: LOCAL_AUDIENCE,
      algorithms: ['HS256'],
    });
    if (payload.token_use !== 'id' || !payload.sub) return null;
    const rawGroups = (payload as Record<string, unknown>)['cognito:groups'];
    const groups = Array.isArray(rawGroups) ? rawGroups.map(String) : settings.groups;
    return {
      sub: String(payload.sub),
      email: payload.email ? String(payload.email) : settings.email,
      groups,
    };
  } catch {
    return null;
  }
}

export function isLocalAuthConfigured(): boolean {
  return getLocalAuthSettings() !== null;
}

function getLocalAuthSettings(): LocalAuthSettings | null {
  const config = getPrivateRuntimeConfig();
  if (config.activeEnvironment !== 'local') return null;
  const localAuth = config.localAuth;
  if (!localAuth?.enabled) return null;

  const email = localAuth.email?.trim();
  const password = localAuth.password ?? '';
  if (!email || !password) return null;

  const secretText = process.env.AWSOPS_LOCAL_AUTH_SECRET
    ?? localAuth.sessionSecret
    ?? `${email}:${password}:awsops-local-auth`;

  return {
    email,
    password,
    groups: localAuth.groups?.map(String) ?? ['admins'],
    secret: new TextEncoder().encode(secretText),
  };
}
