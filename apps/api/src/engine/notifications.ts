import { createHmac } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import nodemailer, { type Transporter } from 'nodemailer';
import type { NotificationChannelKind } from '@trade-copier/contracts';
import type { NotificationChannelRecord, Repositories } from '@trade-copier/db';
import type { Env } from '../config/env.js';

/**
 * Notification outbox worker.
 *
 * Delivery is separated from decision-making: the engine only ever *enqueues*
 * notifications (durable, deduplicated, retried here), so a flaky SMTP server
 * can never slow the copy loop down.
 */
export interface NotificationSenderDeps {
  readonly env: Env;
  readonly repos: Repositories;
  readonly log: FastifyBaseLogger;
  readonly workerId: string;
  readonly maxAttempts?: number;
  readonly now?: (() => Date) | undefined;
}

export class NotificationSender {
  private transporter: Transporter | null = null;

  constructor(private readonly deps: NotificationSenderDeps) {}

  async tick(limit = 20): Promise<number> {
    const claimed = await this.deps.repos.platform.claimNotifications(this.deps.workerId, limit);
    if (claimed.length === 0) return 0;

    for (const row of claimed) {
      const channel = await this.deps.repos.platform.findChannel(row.channelId);
      if (!channel || !channel.enabled) {
        await this.deps.repos.platform.markNotificationFailed({
          notificationId: row.id,
          error: 'channel is missing or disabled',
          nextAttemptAt: new Date(),
          dead: true,
        });
        continue;
      }

      const result = await this.deliver(channel, row.event, row.payload as Record<string, unknown>);
      if (result.ok) continue;

      const attempts = row.attempts;
      const maxAttempts = this.deps.maxAttempts ?? 5;
      const dead = attempts >= maxAttempts;
      const backoffMs = Math.min(30 * 60_000, 15_000 * 2 ** attempts);
      await this.deps.repos.platform.markNotificationFailed({
        notificationId: row.id,
        error: result.error,
        nextAttemptAt: new Date(Date.now() + backoffMs),
        dead,
      });
      this.deps.log[dead ? 'error' : 'warn'](
        { notificationId: row.id, channel: channel.kind, event: row.event, error: result.error, attempts },
        dead ? 'notification dropped after max attempts' : 'notification delivery failed; will retry',
      );
    }
    return claimed.length;
  }

  private async deliver(
    channel: NotificationChannelRecord,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      switch (channel.kind as NotificationChannelKind) {
        case 'email':
          return await this.sendEmail(channel, event, payload);
        case 'telegram':
          return await this.sendTelegram(channel, event, payload);
        case 'webhook':
        case 'slack':
        case 'discord':
          return await this.sendWebhook(channel, event, payload);
        default:
          return { ok: false, error: `unsupported channel kind ${String(channel.kind)}` };
      }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async sendEmail(
    channel: NotificationChannelRecord,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const address = typeof channel.config.address === 'string' ? channel.config.address : null;
    if (!address) return { ok: false, error: 'email channel has no address' };
    if (!this.deps.env.SMTP_HOST) return { ok: false, error: 'SMTP is not configured (SMTP_HOST)' };

    this.transporter ??= nodemailer.createTransport({
      host: this.deps.env.SMTP_HOST,
      port: this.deps.env.SMTP_PORT,
      secure: this.deps.env.SMTP_SECURE,
      ...(this.deps.env.SMTP_USER
        ? { auth: { user: this.deps.env.SMTP_USER, pass: this.deps.env.SMTP_PASSWORD } }
        : {}),
    });

    const subject = `[Trade Copier] ${humanEvent(event)}`;
    const lines = Object.entries(payload)
      .map(([key, value]) => `${key}: ${formatValue(value)}`)
      .join('\n');

    await this.transporter.sendMail({
      from: this.deps.env.MAIL_FROM,
      to: address,
      subject,
      text: `${humanEvent(event)}\n\n${lines}\n`,
    });
    return { ok: true };
  }

  private async sendTelegram(
    channel: NotificationChannelRecord,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const chatId = typeof channel.config.chatId === 'string' ? channel.config.chatId : null;
    const token =
      (typeof channel.config.botToken === 'string' && channel.config.botToken) || this.deps.env.TELEGRAM_BOT_TOKEN;
    if (!chatId) return { ok: false, error: 'telegram channel has no chatId' };
    if (!token) return { ok: false, error: 'telegram bot token is not configured' };

    const lines = Object.entries(payload)
      .map(([key, value]) => `• <b>${escapeHtml(key)}</b>: ${escapeHtml(formatValue(value))}`)
      .join('\n');
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: `<b>${escapeHtml(humanEvent(event))}</b>\n${lines}`, parse_mode: 'HTML' }),
    });
    if (!response.ok) return { ok: false, error: `telegram responded ${response.status}` };
    return { ok: true };
  }

  private async sendWebhook(
    channel: NotificationChannelRecord,
    event: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const url = typeof channel.config.url === 'string' ? channel.config.url : null;
    if (!url) return { ok: false, error: `${channel.kind} channel has no url` };

    const body = JSON.stringify({ event, at: new Date().toISOString(), data: payload });
    const secret =
      (typeof channel.config.secret === 'string' && channel.config.secret) || this.deps.env.NOTIFICATION_WEBHOOK_SECRET;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) headers['x-trade-copier-signature'] = createHmac('sha256', secret).update(body).digest('hex');

    const response = await fetch(url, { method: 'POST', headers, body });
    if (!response.ok) return { ok: false, error: `${channel.kind} responded ${response.status}` };
    return { ok: true };
  }
}

function humanEvent(event: string): string {
  return event
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] ?? char);
}
