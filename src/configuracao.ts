import { LOG_LEVELS, type LogLevel } from './observabilidade/logger-json';

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  name: string;
  /** quanto tempo uma operação espera o lock da carteira antes de desistir (WALLET_BUSY) */
  lockTimeoutMs: number;
}

export interface SqsConfig {
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  outboxQueueName: string;
  /** fila FIFO de entrada das transações */
  inputQueueName: string;
  /** dead-letter da fila de entrada */
  dlqName: string;
}

export interface ConsumerConfig {
  /** liga o consumidor da fila de entrada nesta instância */
  enabled: boolean;
  /** nome que identifica o consumidor na inbox */
  name: string;
  /** recebimentos com falha transitória antes de mandar pra DLQ */
  maxAttempts: number;
  /** base do backoff entre tentativas, em segundos (2^tentativa * base, até 300 s) */
  retryBaseSeconds: number;
  /** long polling do ReceiveMessage, de 0 a 20 s */
  waitTimeSeconds: number;
  /** quanto tempo o shutdown espera as mensagens em andamento */
  shutdownTimeoutMs: number;
}

export interface PendingReferenceConfig {
  /** liga o worker que reprocessa PENDING_REFERENCE nesta instância */
  workerEnabled: boolean;
  pollIntervalMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxAttempts: number;
}

export interface OutboxConfig {
  /** liga o loop de publicação nesta instância. pode ligar em todas ao mesmo tempo */
  publisherEnabled: boolean;
  pollIntervalMs: number;
}

export interface AppConfig {
  port: number;
  /** error, warn, info ou debug */
  logLevel: LogLevel;
  db: DatabaseConfig;
  sqs: SqsConfig;
  outbox: OutboxConfig;
  consumer: ConsumerConfig;
  pendingReference: PendingReferenceConfig;
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

function optionalIntInRange(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Variável de ambiente ${name} deve ser inteiro de ${min} a ${max}: ${raw}`);
  }
  return value;
}

function optional(env: Env, name: string, fallback: string): string {
  const raw = env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}

export function loadDatabaseConfig(env: Env = process.env): DatabaseConfig {
  return {
    host: required(env, 'DB_HOST'),
    port: port(env, 'DB_PORT'),
    user: required(env, 'DB_USER'),
    password: required(env, 'DB_PASSWORD'),
    name: required(env, 'DB_NAME'),
    lockTimeoutMs: optionalPositiveInt(env, 'DB_LOCK_TIMEOUT_MS', 5000),
  };
}

export function loadConfig(env: Env = process.env): AppConfig {
  const logLevel = optional(env, 'LOG_LEVEL', 'info');
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    throw new Error(`Variável de ambiente LOG_LEVEL deve ser ${LOG_LEVELS.join(', ')}: ${logLevel}`);
  }
  return {
    port: port(env, 'PORT'),
    logLevel: logLevel as LogLevel,
    db: loadDatabaseConfig(env),
    sqs: {
      region: required(env, 'AWS_REGION'),
      endpoint: required(env, 'SQS_ENDPOINT'),
      accessKeyId: required(env, 'AWS_ACCESS_KEY_ID'),
      secretAccessKey: required(env, 'AWS_SECRET_ACCESS_KEY'),
      outboxQueueName: required(env, 'SQS_OUTBOX_QUEUE_NAME'),
      inputQueueName: optional(env, 'SQS_INPUT_QUEUE_NAME', 'wager-transactions.fifo'),
      dlqName: optional(env, 'SQS_DLQ_NAME', 'wager-transactions-dlq.fifo'),
    },
    outbox: {
      publisherEnabled: optionalBoolean(env, 'OUTBOX_PUBLISHER_ENABLED', true),
      pollIntervalMs: optionalPositiveInt(env, 'OUTBOX_POLL_INTERVAL_MS', 500),
    },
    consumer: {
      enabled: optionalBoolean(env, 'CONSUMER_ENABLED', true),
      name: optional(env, 'CONSUMER_NAME', 'wager-transactions-consumer'),
      maxAttempts: optionalPositiveInt(env, 'CONSUMER_MAX_ATTEMPTS', 5),
      retryBaseSeconds: optionalIntInRange(env, 'CONSUMER_RETRY_BASE_SECONDS', 2, 0, 300),
      waitTimeSeconds: optionalIntInRange(env, 'CONSUMER_WAIT_TIME_SECONDS', 10, 0, 20),
      shutdownTimeoutMs: optionalPositiveInt(env, 'CONSUMER_SHUTDOWN_TIMEOUT_MS', 10_000),
    },
    pendingReference: {
      workerEnabled: optionalBoolean(env, 'PENDING_REFERENCE_WORKER_ENABLED', true),
      pollIntervalMs: optionalPositiveInt(env, 'PENDING_REFERENCE_POLL_INTERVAL_MS', 1000),
      baseDelayMs: optionalPositiveInt(env, 'PENDING_REFERENCE_BASE_DELAY_MS', 1000),
      maxDelayMs: optionalPositiveInt(env, 'PENDING_REFERENCE_MAX_DELAY_MS', 60_000),
      maxAttempts: optionalPositiveInt(env, 'PENDING_REFERENCE_MAX_ATTEMPTS', 10),
    },
  };
}
