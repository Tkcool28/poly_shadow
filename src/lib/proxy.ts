import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Agent } from 'http';
import { PROXY_MAX_CONSECUTIVE_ERRORS, PROXY_COOLDOWN_MS } from '../config/constants';
import { logger } from './logger';

interface ProxyEntry {
  url: string;
  protocol: 'socks5' | 'http' | 'https';
  consecutiveErrors: number;
  cooldownUntil: number;
}

export class ProxyRotator {
  private proxies: ProxyEntry[] = [];
  private index = 0;
  private enabled: boolean;

  constructor(enabled: boolean, proxyList: string) {
    this.enabled = enabled;
    if (enabled && proxyList) {
      this.proxies = proxyList
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((url) => ({
          url,
          protocol: this.parseProtocol(url),
          consecutiveErrors: 0,
          cooldownUntil: 0,
        }));

      if (this.proxies.length > 0) {
        logger.info(`Proxy rotator initialized with ${this.proxies.length} proxies`);
      }
    }
  }

  private parseProtocol(url: string): 'socks5' | 'http' | 'https' {
    if (url.startsWith('socks5://') || url.startsWith('socks://')) return 'socks5';
    if (url.startsWith('https://')) return 'https';
    return 'http';
  }

  private getNextAvailable(): ProxyEntry | null {
    if (!this.enabled || this.proxies.length === 0) return null;

    const now = Date.now();
    const startIndex = this.index;

    // Try to find an available proxy
    for (let i = 0; i < this.proxies.length; i++) {
      const idx = (startIndex + i) % this.proxies.length;
      const proxy = this.proxies[idx];
      if (proxy.cooldownUntil <= now) {
        this.index = (idx + 1) % this.proxies.length;
        return proxy;
      }
    }

    // All proxies are on cooldown — use the first one anyway
    logger.warn('All proxies on cooldown, using first available');
    const fallback = this.proxies[this.index % this.proxies.length];
    this.index = (this.index + 1) % this.proxies.length;
    return fallback;
  }

  createAgent(): Agent | undefined {
    const proxy = this.getNextAvailable();
    if (!proxy) return undefined;

    if (proxy.protocol === 'socks5') {
      return new SocksProxyAgent(proxy.url) as unknown as Agent;
    }
    return new HttpsProxyAgent(proxy.url) as unknown as Agent;
  }

  reportSuccess(proxyUrl?: string): void {
    if (!proxyUrl) return;
    const proxy = this.proxies.find((p) => p.url === proxyUrl);
    if (proxy) {
      proxy.consecutiveErrors = 0;
    }
  }

  reportError(proxyUrl?: string): void {
    if (!proxyUrl) return;
    const proxy = this.proxies.find((p) => p.url === proxyUrl);
    if (proxy) {
      proxy.consecutiveErrors++;
      if (proxy.consecutiveErrors >= PROXY_MAX_CONSECUTIVE_ERRORS) {
        proxy.cooldownUntil = Date.now() + PROXY_COOLDOWN_MS;
        logger.warn(`Proxy ${this.maskUrl(proxy.url)} put on cooldown for ${PROXY_COOLDOWN_MS}ms after ${proxy.consecutiveErrors} errors`);
        proxy.consecutiveErrors = 0;
      }
    }
  }

  getCurrentProxyUrl(): string | undefined {
    if (!this.enabled || this.proxies.length === 0) return undefined;
    const idx = (this.index - 1 + this.proxies.length) % this.proxies.length;
    return this.proxies[idx]?.url;
  }

  get isEnabled(): boolean {
    return this.enabled && this.proxies.length > 0;
  }

  private maskUrl(url: string): string {
    try {
      const parsed = new URL(url);
      if (parsed.password) {
        parsed.password = '***';
      }
      if (parsed.username) {
        parsed.username = parsed.username.slice(0, 2) + '***';
      }
      return parsed.toString();
    } catch {
      return '***masked***';
    }
  }
}
