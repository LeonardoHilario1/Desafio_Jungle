import type { INestApplication } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/postgresql';
import { createApp } from '../../src/aplicacao';
import type { AppConfig } from '../../src/configuracao';
import { testConfig } from './test-config';

export interface ApiResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
}

export interface TestApi {
  app: INestApplication;
  orm: MikroORM;
  post<T = any>(path: string, body: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>>;
  get<T = any>(path: string): Promise<ApiResponse<T>>;
  close(): Promise<void>;
}

/** Sobe a aplicação real (Nest + MikroORM + PostgreSQL de teste) numa porta livre. */
export async function startApi(configure: (config: AppConfig) => AppConfig = (c) => c): Promise<TestApi> {
  const app = await createApp(configure(testConfig()));
  await app.listen(0, '127.0.0.1');
  const url = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  async function request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: (text ? JSON.parse(text) : null) as T };
  }

  return {
    app,
    orm: app.get(MikroORM),
    post: (path, body, headers) => request('POST', path, body, headers),
    get: (path) => request('GET', path),
    close: () => app.close(),
  };
}
