export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  name: string;
}

export interface SqsConfig {
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  outboxQueueName: string;
}

export interface OutboxConfig {
  /** liga o loop de publicação nesta instância. pode ligar em todas ao mesmo tempo */
  publisherEnabled: boolean;
  pollIntervalMs: number;
}

export interface AppConfig {
  port: number;
  db: DatabaseConfig;
  sqs: SqsConfig;
  outbox: OutboxConfig;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  }
  return value;
}

function port(env: Env, name: string): number {
  const raw = required(env, name);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new Error(`Variável de ambiente ${name} não é uma porta válida: ${raw}`);
  }
  return value;
}

function optionalBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (raw !== 'true' && raw !== 'false') {
    throw new Error(`Variável de ambiente ${name} deve ser true ou false: ${raw}`);
  }
  return raw === 'true';
}

function optionalPositiveInt(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Variável de ambiente ${name} deve ser inteiro positivo: ${raw}`);
  }
  return value;
}

export function loadDatabaseConfig(env: Env = process.env): DatabaseConfig {
  return {
    host: required(env, 'DB_HOST'),
    port: port(env, 'DB_PORT'),
    user: required(env, 'DB_USER'),
    password: required(env, 'DB_PASSWORD'),
    name: required(env, 'DB_NAME'),
  };
}

export function loadConfig(env: Env = process.env): AppConfig {
  return {
    port: port(env, 'PORT'),
    db: loadDatabaseConfig(env),
    sqs: {
      region: required(env, 'AWS_REGION'),
      endpoint: required(env, 'SQS_ENDPOINT'),
      accessKeyId: required(env, 'AWS_ACCESS_KEY_ID'),
      secretAccessKey: required(env, 'AWS_SECRET_ACCESS_KEY'),
      outboxQueueName: required(env, 'SQS_OUTBOX_QUEUE_NAME'),
    },
    outbox: {
      publisherEnabled: optionalBoolean(env, 'OUTBOX_PUBLISHER_ENABLED', true),
      pollIntervalMs: optionalPositiveInt(env, 'OUTBOX_POLL_INTERVAL_MS', 500),
    },
  };
}
