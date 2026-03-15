import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend = process.env.RESEND_API_KEY
    ? new Resend(process.env.RESEND_API_KEY)
    : null;

  private async sendEmail(options: {
    to: string;
    subject: string;
    html: string;
  }) {
    if (!this.resend || !process.env.EMAIL_FROM) {
      this.logger.warn(
        `Skipping email to ${options.to} because RESEND_API_KEY or EMAIL_FROM is not configured.`,
      );
      return;
    }

    try {
      await this.resend.emails.send({
        from: process.env.EMAIL_FROM,
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
}
