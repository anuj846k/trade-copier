#!/usr/bin/env node
import { createServer } from 'node:http';
import { CloudClient } from './cloud-client.js';
import { EaLink, type EaLinkLogger } from './ea-link.js';
import { AgentConfigError, loadAgentConfig } from './config.js';

/**
 * Bridge agent entry point.
 *
 * Run it on the machine that hosts the MetaTrader terminals (a Windows VPS in
 * practice). It exposes one local HTTP endpoint per configured account that the
 * Expert Advisor polls, and maintains a single outbound WebSocket to the copy
 * server so no inbound port ever has to be opened on the VPS.
 *
 *   node dist/index.js --config agent.config.json
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;

function makeLogger(level: keyof typeof LEVELS): EaLinkLogger {
  const threshold = LEVELS[level];
  const write = (stream: NodeJS.WriteStream, name: keyof typeof LEVELS, message: string, context?: Record<string, unknown>) => {
    if (LEVELS[name] < threshold) return;
    const stamp = new Date().toISOString();
    const extra = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : '';
    stream.write(`${stamp} ${name.toUpperCase().padEnd(5)} ${message}${extra}\n`);
  };
  return {
    debug: (message, context) => write(process.stdout, 'debug', message, context),
    info: (message, context) => write(process.stdout, 'info', message, context),
    warn: (message, context) => write(process.stderr, 'warn', message, context),
    error: (message, context) => write(process.stderr, 'error', message, context),
  };
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadAgentConfig();
  } catch (error) {
    if (error instanceof AgentConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const log = makeLogger(config.logLevel);
  log.info('starting bridge agent', {
    name: config.name,
    serverUrl: config.serverUrl,
    accounts: config.accounts.length,
  });

  const links: EaLink[] = [];
  for (const account of config.accounts) {
    const link = new EaLink({ config: account, log, emit: (message) => client.send(message) });
    links.push(link);
  }

  const client = new CloudClient({ config, links, log });

  for (const link of links) {
    await link.start();
  }
  client.start();

  if (config.healthPort !== null) {
    const health = createServer((request, response) => {
      if (request.url !== '/health' && request.url !== '/status') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      const cloud = client.status();
      const body = {
        status: cloud.connected ? 'ok' : 'degraded',
        agent: config.name,
        version: config.version,
        cloud,
        terminals: links.map((link) => link.status()),
        checkedAt: new Date().toISOString(),
      };
      response.writeHead(cloud.connected ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body, null, 2));
    });
    health.listen(config.healthPort, '127.0.0.1', () => {
      log.info('health endpoint listening', { url: `http://127.0.0.1:${config.healthPort}/health` });
    });
    health.unref?.();
  }

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    await client.stop();
    for (const link of links) await link.stop();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main();
