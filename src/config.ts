export interface RelayConfig {
  spectrum: {
    projectId: string;
    projectSecret: string;
  };
  supabase: {
    url: string;
    secretKey: string;
  };
  openRouter: {
    apiKey: string;
    model: string;
  };
  github: {
    appId: string;
    clientId: string;
    clientSecret: string;
    privateKey: string;
    slug: string;
    callbackUrl: string;
  };
  http: {
    port: number;
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parsePort(value: string | undefined): number {
  if (!value) return 3000;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("HTTP_PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const supabaseSecret =
    env.SUPABASE_SECRET_KEY?.trim() ??
    env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!supabaseSecret) {
    throw new Error(
      "Missing required environment variable: SUPABASE_SECRET_KEY",
    );
  }

  return {
    spectrum: {
      projectId: required(env, "PROJECT_ID"),
      projectSecret: required(env, "PROJECT_SECRET"),
    },
    supabase: {
      url: required(env, "SUPABASE_URL"),
      secretKey: supabaseSecret,
    },
    openRouter: {
      apiKey: required(env, "OPENROUTER_API_KEY"),
      model: required(env, "OPENROUTER_MODEL"),
    },
    github: {
      appId: required(env, "GITHUB_APP_ID"),
      clientId: required(env, "GITHUB_CLIENT_ID"),
      clientSecret: required(env, "GITHUB_CLIENT_SECRET"),
      privateKey: required(env, "GITHUB_PRIVATE_KEY").replaceAll("\\n", "\n"),
      slug: required(env, "GITHUB_APP_SLUG"),
      callbackUrl: required(env, "GITHUB_CALLBACK_URL"),
    },
    http: {
      port: parsePort(env.HTTP_PORT),
    },
  };
}
