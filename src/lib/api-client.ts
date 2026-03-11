import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { ProxyRotator } from './proxy';
import { getRateLimiter } from './rate-limiter';
import { logger } from './logger';
import { config } from '../config/env';

const proxyRotator = new ProxyRotator(config.PROXY_ENABLED, config.PROXY_LIST);

function createAxiosInstance(baseURL: string): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: 30000,
    headers: {
      'Accept': 'application/json',
    },
  });

  // Attach proxy agent on each request
  instance.interceptors.request.use((reqConfig) => {
    const agent = proxyRotator.createAgent();
    if (agent) {
      reqConfig.httpAgent = agent;
      reqConfig.httpsAgent = agent;
    }
    return reqConfig;
  });

  return instance;
}

const dataApiAxios = createAxiosInstance(config.DATA_API_BASE_URL);
const gammaApiAxios = createAxiosInstance(config.GAMMA_API_BASE_URL);

async function requestWithRetry<T>(
  instance: AxiosInstance,
  path: string,
  params?: Record<string, unknown>,
  retries = 3
): Promise<T> {
  const limiter = getRateLimiter(path);
  const start = Date.now();
  let lastError: Error | undefined;

  // Retry loop is OUTSIDE limiter.schedule() so the concurrency slot is released
  // during backoff sleep, preventing slot starvation on 429 bursts
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await limiter.schedule(() =>
        instance.get<T>(path, { params })
      );
      const duration = Date.now() - start;
      logger.debug(`API ${instance.defaults.baseURL}${path}`, {
        status: response.status,
        duration,
        attempt,
      });
      if (proxyRotator.isEnabled) {
        proxyRotator.reportSuccess(proxyRotator.getCurrentProxyUrl());
      }
      return response.data;
    } catch (error: any) {
      lastError = error;
      const status = error.response?.status;
      const duration = Date.now() - start;

      if (proxyRotator.isEnabled) {
        proxyRotator.reportError(proxyRotator.getCurrentProxyUrl());
      }

      // Only retry on 429 (rate limit) or 5xx (server error)
      if (status && status !== 429 && status < 500) {
        logger.warn(`API ${path} failed with ${status}, not retrying`, { status, duration, attempt });
        throw error;
      }

      if (attempt < retries) {
        const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        logger.warn(`API ${path} failed (attempt ${attempt}/${retries}), retrying in ${delay}ms`, {
          status: status ?? 'network_error',
          duration,
        });
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  logger.error(`API ${path} failed after ${retries} attempts`, { error: lastError?.message });
  throw lastError;
}

export const dataApi = {
  get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return requestWithRetry<T>(dataApiAxios, path, params);
  },
};

export const gammaApi = {
  get<T>(path: string, params?: Record<string, unknown>): Promise<T> {
    return requestWithRetry<T>(gammaApiAxios, path, params);
  },
};
