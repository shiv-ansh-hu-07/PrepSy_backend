import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend = process.env.RESEND_API_KEY
    ? new Resend(process.env.RESEND_API_KEY)
    : null;
  private readonly defaultSenderName = 'Prepsy';

  private getFromAddress() {
    const from = process.env.EMAIL_FROM?.trim();

    if (!from) {
      return null;
    }

    if (from.includes('<') && from.includes('>')) {
      const address = from.match(/<([^>]+)>/)?.[1]?.trim();
      return address ? `${this.defaultSenderName} <${address}>` : from;
    }

    return `${this.defaultSenderName} <${from}>`;
  }

  private async sendEmail(options: {
    to: string;
    subject: string;
    html: string;
  }) {
    const fromAddress = this.getFromAddress();

    if (!this.resend || !fromAddress) {
      this.logger.warn(
        `Skipping email to ${options.to} because RESEND_API_KEY or EMAIL_FROM is not configured.`,
      );
      return;
    }

    try {
      await this.resend.emails.send({
        from: fromAddress,
        to: options.to,
        subject: options.subject,
        html: options.html,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown email error';
      this.logger.error(`Failed to send email to ${options.to}: ${message}`);
    }
  }

  private formatSchedule(startTime: Date, timeZone?: string) {
    return new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: timeZone || 'UTC',
    }).format(startTime);
  }

  async sendScheduledRoomConfirmationEmail(
    to: string,
    roomName: string,
    startTime: Date,
    durationMinutes?: number | null,
    timeZone?: string,
  ) {
    const formattedStart = this.formatSchedule(startTime, timeZone);
    const durationLine = durationMinutes
      ? `<p>Duration: ${durationMinutes} minutes</p>`
      : '';

    await this.sendEmail({
      to,
      subject: `Your classroom "${roomName}" is scheduled`,
      html: `
        <h2>${roomName}</h2>
        <p>Your classroom has been scheduled successfully.</p>
        <p>Starts at: ${formattedStart}</p>
        ${durationLine}
        <p>We will remind all participants 15 minutes before it begins.</p>
      `,
    });
  }

  async sendCohortSessionEmail(
    to: string,
    cohortName: string,
    topic: string,
    joinUrl: string,
  ) {
    await this.sendEmail({
      to,
      subject: `Today in "${cohortName}": ${topic}`,
      html: `
        <h2>Today's session</h2>
        <p><strong>${topic}</strong></p>
        <p>Your "${cohortName}" study room is ready — join your cohort and study together.</p>
        <p><a href="${joinUrl}" style="background:#7c3aed;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Join the room</a></p>
      `,
    });
  }

  async sendReminderEmail(
    to: string,
    roomName: string,
    startTime: Date,
    timeZone?: string,
  ) {
    await this.sendEmail({
      to,
      subject: 'Your study room starts in 15 minutes',
      html: `
        <h2>${roomName}</h2>
        <p>Your study session starts at ${this.formatSchedule(startTime, timeZone)}</p>
        <p>Join now and stay consistent.</p>
      `,
    });
  }

  async sendJoinNudgeEmail(to: string, roomName: string, joinedCount: number) {
    await this.sendEmail({
      to,
      subject: `${joinedCount} students already studying`,
      html: `
        <h2>${roomName}</h2>
        <p>${joinedCount} students are already studying.</p>
        <p>Join now and do not fall behind.</p>
      `,
    });
  }

  async sendStreakRescueEmail(
    to: string,
    name: string,
    streakDays: number,
  ) {
    await this.sendEmail({
      to,
      subject: `Your ${streakDays}-day streak dies tonight 🔥`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fafafa;border-radius:16px">
          <h2 style="color:#2f3b63;margin:0 0 12px">Hey ${name || 'there'} 👋</h2>
          <p style="color:#4a5a85;font-size:16px;line-height:1.6;margin:0 0 20px">
            You've built a <strong>${streakDays}-day study streak</strong> on PrepSy — that's real consistency. But you haven't studied yet today.
          </p>
          <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:16px 20px;margin:0 0 24px">
            <p style="color:#c2410c;font-weight:600;margin:0;font-size:15px">
              ⚠ Your streak resets at midnight. One short session saves it.
            </p>
          </div>
          <a href="${process.env.FRONTEND_URL || 'https://prepsy.app'}" style="display:inline-block;padding:12px 28px;background:#7c3aed;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px">
            Study now →
          </a>
          <p style="color:#9aa4c7;font-size:12px;margin:24px 0 0">Even 15 minutes counts. You've got this.</p>
        </div>
      `,
    });
  }

  async sendWeeklyReportEmail(
    to: string,
    name: string,
    report: {
      totalMinutes: number;
      totalLabel: string;
      sessionsCompleted: number;
      bestDayLabel: string;
      avgFocusScore: number | null;
      streakDays: number;
    },
  ) {
    const focusLine =
      report.avgFocusScore !== null
        ? `<p style="color:#4a5a85;margin:0 0 8px">🎯 Average AI focus score: <strong>${report.avgFocusScore}/100</strong></p>`
        : '';

    await this.sendEmail({
      to,
      subject: `Your PrepSy week: ${report.totalLabel} studied 📊`,
      html: `
        <div style="font-family:Inter,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#fafafa;border-radius:16px">
          <h2 style="color:#2f3b63;margin:0 0 6px">This week on PrepSy</h2>
          <p style="color:#6b78a0;margin:0 0 24px;font-size:14px">Weekly summary for ${name || 'you'}</p>
          <div style="background:#fff;border:1px solid #e8ecff;border-radius:14px;padding:20px 24px;margin:0 0 20px">
            <p style="color:#4a5a85;margin:0 0 8px">⏱ Total study time: <strong>${report.totalLabel}</strong></p>
            <p style="color:#4a5a85;margin:0 0 8px">✅ Sessions completed: <strong>${report.sessionsCompleted}</strong></p>
            <p style="color:#4a5a85;margin:0 0 8px">📅 Best day: <strong>${report.bestDayLabel}</strong></p>
            ${focusLine}
            <p style="color:#4a5a85;margin:0">🔥 Current streak: <strong>${report.streakDays} day${report.streakDays === 1 ? '' : 's'}</strong></p>
          </div>
          <a href="${process.env.FRONTEND_URL || 'https://prepsy.app'}" style="display:inline-block;padding:12px 28px;background:#7c3aed;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px">
            Keep the momentum →
          </a>
          <p style="color:#9aa4c7;font-size:12px;margin:24px 0 0">See you next week 👋</p>
        </div>
      `,
    });
  }
}
