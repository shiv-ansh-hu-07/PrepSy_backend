import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend = process.env.RESEND_API_KEY
    ? new Resend(process.env.RESEND_API_KEY)
    : null;
  private readonly defaultSenderName = 'Prepsy';

  constructor(private readonly prisma: PrismaService) {}

  private getFrontendUrl() {
    return (process.env.FRONTEND_URL || 'https://prepsy.in').replace(/\/+$/, '');
  }

  // A user can opt out of reminder-type emails from their profile. Transactional
  // mail (e.g. a room-creation confirmation) does not call this. Defaults to ON,
  // and never blocks an email on a lookup error.
  private async notificationsAllowed(to: string): Promise<boolean> {
    try {
      const user = await this.prisma.user.findUnique({
        where: { email: to },
        select: { profile: { select: { emailNotifications: true } } },
      });
      return user?.profile?.emailNotifications ?? true;
    } catch {
      return true;
    }
  }

  // Footer with the one-tap way out — lands on the Profile toggle.
  private unsubscribeFooter(): string {
    const url = `${this.getFrontendUrl()}/profile#notifications`;
    return `
      <p style="color:#9aa4c7;font-size:12px;line-height:1.6;margin:26px 0 0;border-top:1px solid #eef0f7;padding-top:16px">
        You're getting this because study reminders are on.
        <a href="${url}" style="color:#7c3aed;text-decoration:underline">Turn off email notifications</a>.
      </p>`;
  }

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
    replyTo?: string;
  }): Promise<boolean> {
    const fromAddress = this.getFromAddress();

    if (!this.resend || !fromAddress) {
      this.logger.warn(
        `Skipping email to ${options.to} because RESEND_API_KEY or EMAIL_FROM is not configured.`,
      );
      return false;
    }

    try {
      await this.resend.emails.send({
        from: fromAddress,
        to: options.to,
        subject: options.subject,
        html: options.html,
        ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      });
      return true;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown email error';
      this.logger.error(`Failed to send email to ${options.to}: ${message}`);
      return false;
    }
  }

  // ── Contact form ──────────────────────────────────────────────────────────
  // Sends a visitor's message to the founder inbox (CONTACT_EMAIL), with the
  // sender set as reply-to so the founder can reply straight from Gmail.
  async sendContactEmail(data: {
    name: string;
    email: string;
    subject?: string;
    message: string;
  }): Promise<boolean> {
    const to =
      process.env.CONTACT_EMAIL?.trim() || 'shivanshu0503tiwari@gmail.com';
    const esc = (s: string) =>
      String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] as string);
    const subject = data.subject?.trim() || 'New message';

    return this.sendEmail({
      to,
      replyTo: data.email,
      subject: `📨 Prepsy contact: ${esc(subject)}`,
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:560px;margin:0 auto;padding:28px 24px;background:#fafbff;border-radius:16px">
          <h2 style="color:#2f3b63;margin:0 0 14px">New contact message</h2>
          <div style="background:#fff;border:1px solid #e8ecff;border-radius:12px;padding:16px 18px">
            <p style="margin:0 0 8px;color:#4a5a85;font-size:14px"><strong>From:</strong> ${esc(data.name)} &lt;${esc(data.email)}&gt;</p>
            <p style="margin:0 0 12px;color:#4a5a85;font-size:14px"><strong>Subject:</strong> ${esc(subject)}</p>
            <p style="margin:0;color:#2f3b63;font-size:15px;line-height:1.6;white-space:pre-wrap">${esc(data.message)}</p>
          </div>
          <p style="color:#9aa4c7;font-size:12px;margin:14px 0 0">Reply directly to this email to respond to ${esc(data.name)}.</p>
        </div>
      `,
    });
  }

  private formatSchedule(startTime: Date, timeZone?: string) {
    return new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: timeZone || 'UTC',
    }).format(startTime);
  }

  // Transactional — always sent (you just created the room). No opt-out gate.
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

  // ── Rich session reminder ────────────────────────────────────────────────
  // The descriptive "come join the class" email: room, live analytics, what
  // missing it costs, and a direct join button. Gated by the opt-out.
  async sendSessionReminderEmail(
    to: string,
    data: {
      name?: string | null;
      roomName: string;
      joinUrl: string;
      topic?: string | null;
      startLabel?: string | null;
      streakDays: number;
      weekLabel: string;
      sessionsThisWeek: number;
      goalLabel?: string | null;
    },
  ) {
    if (!(await this.notificationsAllowed(to))) return;

    const name = data.name?.trim() || 'there';
    const topicLine = data.topic
      ? `<p style="color:#2f3b63;font-size:16px;font-weight:600;margin:0 0 6px">Today: ${data.topic}</p>`
      : '';
    const startLine = data.startLabel
      ? `<p style="color:#6b78a0;font-size:14px;margin:0 0 18px">Starts ${data.startLabel}</p>`
      : '';
    const goalPart = data.goalLabel
      ? ` <span style="color:#9aa4c7">/ goal ${data.goalLabel}</span>`
      : '';
    const streakRisk =
      data.streakDays > 0
        ? `🔥 You're on a <strong>${data.streakDays}-day streak</strong> — skip today and it resets to <strong>0</strong>.`
        : `Show up today to <strong>start a streak</strong> — consistency is what moves your analytics.`;

    await this.sendEmail({
      to,
      subject: data.topic
        ? `Your session is on: ${data.topic}`
        : `Time to study — ${data.roomName}`,
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fafbff;border-radius:16px">
          <h2 style="color:#2f3b63;margin:0 0 6px">Time to study, ${name} 👋</h2>
          <p style="color:#4a5a85;font-size:15px;margin:0 0 4px"><strong>${data.roomName}</strong> is ready for you.</p>
          ${startLine}
          ${topicLine}

          <div style="background:#fff;border:1px solid #e8ecff;border-radius:14px;padding:18px 20px;margin:6px 0 16px">
            <p style="color:#8b95bd;font-size:11px;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;margin:0 0 10px">Your progress</p>
            <p style="color:#4a5a85;font-size:14px;margin:0 0 7px">🔥 Current streak: <strong>${data.streakDays} day${data.streakDays === 1 ? '' : 's'}</strong></p>
            <p style="color:#4a5a85;font-size:14px;margin:0 0 7px">⏱ This week: <strong>${data.weekLabel}</strong>${goalPart}</p>
            <p style="color:#4a5a85;font-size:14px;margin:0">✅ Sessions this week: <strong>${data.sessionsThisWeek}</strong></p>
          </div>

          <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:14px 18px;margin:0 0 22px">
            <p style="color:#c2410c;font-size:14px;line-height:1.6;margin:0">
              ${streakRisk} Missing this session also flattens your weekly focus time and dents your consistency score.
            </p>
          </div>

          <a href="${data.joinUrl}" style="display:inline-block;padding:13px 30px;background:#7c3aed;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px">
            Join this session →
          </a>
          <p style="color:#9aa4c7;font-size:12px;margin:16px 0 0">Even 20 focused minutes keeps the momentum going.</p>
          ${this.unsubscribeFooter()}
        </div>
      `,
    });
  }

  // ── "You're the missing one" cohort nudge ────────────────────────────────
  // The personal, social, loss-framed evening reminder: your crew, your shared
  // streak on the line, who already showed up, and exactly what skipping costs.
  async sendCohortStreakEmail(
    to: string,
    data: {
      name?: string | null;
      cohortName: string;
      topic: string;
      joinUrl: string;
      personalStreak: number;
      cohortStreak: number;
      completedNames: string[];
      memberCount: number;
      behind: number;
    },
  ) {
    if (!(await this.notificationsAllowed(to))) return;

    const name = data.name?.trim() || 'there';
    const done = data.completedNames.filter(Boolean);

    // "Aman, Riya and 2 others" — social proof of who already studied today.
    const nameList = (names: string[]) => {
      if (names.length === 0) return '';
      if (names.length === 1) return names[0];
      if (names.length === 2) return `${names[0]} and ${names[1]}`;
      return `${names[0]}, ${names[1]} and ${names.length - 2} other${names.length - 2 === 1 ? '' : 's'}`;
    };

    const socialLine =
      done.length > 0
        ? `<strong>${nameList(done)}</strong> already studied today. You're one of the few who hasn't yet.`
        : `Nobody in your crew has studied yet today — be the one who gets everyone going.`;

    const streakLine =
      data.cohortStreak > 0
        ? `Your crew is on a <strong>${data.cohortStreak}-day streak</strong> 🔥 — if enough of you skip today, <strong>it resets to 0 at midnight</strong>.`
        : `Show up tonight and help your crew start a streak.`;

    const personalLine =
      data.personalStreak > 0
        ? `You'd also lose your own <strong>${data.personalStreak}-day streak</strong>.`
        : '';

    const behindLine =
      data.behind > 0
        ? `You're currently <strong>${data.behind} day${data.behind === 1 ? '' : 's'} behind</strong> — tonight's the chance to close the gap.`
        : `You're right on track — don't give that up now.`;

    const subject =
      done.length > 0
        ? `You're the missing one in ${data.cohortName} today`
        : data.cohortStreak > 0
          ? `Your crew's ${data.cohortStreak}-day streak ends tonight`
          : `Your crew is studying — ${data.cohortName}`;

    await this.sendEmail({
      to,
      subject,
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fafbff;border-radius:16px">
          <h2 style="color:#2f3b63;margin:0 0 6px">Your crew is missing you, ${name} 👀</h2>
          <p style="color:#4a5a85;font-size:15px;margin:0 0 4px"><strong>${data.cohortName}</strong> · today: ${data.topic}</p>

          <div style="background:#fff;border:1px solid #e8ecff;border-radius:14px;padding:18px 20px;margin:16px 0">
            <p style="color:#4a5a85;font-size:15px;line-height:1.6;margin:0 0 10px">${socialLine}</p>
            <p style="color:#4a5a85;font-size:14px;line-height:1.6;margin:0">${behindLine}</p>
          </div>

          <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:14px 18px;margin:0 0 22px">
            <p style="color:#c2410c;font-size:14px;line-height:1.6;margin:0">
              ${streakLine} ${personalLine}
            </p>
          </div>

          <a href="${data.joinUrl}" style="display:inline-block;padding:13px 30px;background:#7c3aed;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px">
            Join your crew now →
          </a>
          <p style="color:#9aa4c7;font-size:12px;margin:16px 0 0">Even 20 minutes tonight keeps the streak — and your crew — alive.</p>
          ${this.unsubscribeFooter()}
        </div>
      `,
    });
  }

  // ── No-show nudge (~10 min after start) ──────────────────────────────────
  async sendMissedSessionEmail(
    to: string,
    data: {
      name?: string | null;
      cohortName: string;
      topic: string;
      joinUrl: string;
      streakDays: number;
    },
  ) {
    if (!(await this.notificationsAllowed(to))) return;

    const name = data.name?.trim() || 'there';
    const streakLine =
      data.streakDays > 0
        ? `You're on a <strong>${data.streakDays}-day streak</strong> 🔥 — miss today and it <strong>resets to 0</strong>.`
        : `Show up today to <strong>start a streak</strong> — it's the habit that compounds.`;

    await this.sendEmail({
      to,
      subject: `You're missing "${data.topic}" — your crew already started`,
      html: `
        <div style="font-family:Inter,Arial,sans-serif;max-width:540px;margin:0 auto;padding:32px 24px;background:#fafbff;border-radius:16px">
          <h2 style="color:#2f3b63;margin:0 0 6px">Your session already started, ${name} ⏰</h2>
          <p style="color:#4a5a85;font-size:15px;margin:0 0 4px"><strong>${data.cohortName}</strong> · today: ${data.topic}</p>
          <p style="color:#6b78a0;font-size:13px;margin:0 0 16px">It kicked off about 10 minutes ago and you're not in yet.</p>

          <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:14px 18px;margin:0 0 22px">
            <p style="color:#c2410c;font-size:14px;line-height:1.6;margin:0">${streakLine} It's not too late — jump in now and keep it alive.</p>
          </div>

          <a href="${data.joinUrl}" style="display:inline-block;padding:13px 30px;background:#7c3aed;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px">
            Join now →
          </a>
          <p style="color:#9aa4c7;font-size:12px;margin:16px 0 0">Even 20 focused minutes still counts for today.</p>
          ${this.unsubscribeFooter()}
        </div>
      `,
    });
  }

  async sendCohortSessionEmail(
    to: string,
    cohortName: string,
    topic: string,
    joinUrl: string,
  ) {
    if (!(await this.notificationsAllowed(to))) return;

    await this.sendEmail({
      to,
      subject: `Today in "${cohortName}": ${topic}`,
      html: `
        <h2>Today's session</h2>
        <p><strong>${topic}</strong></p>
        <p>Your "${cohortName}" study room is ready — join your cohort and study together.</p>
        <p><a href="${joinUrl}" style="background:#7c3aed;color:#ffffff;padding:10px 18px;border-radius:8px;text-decoration:none;display:inline-block">Join the room</a></p>
        ${this.unsubscribeFooter()}
      `,
    });
  }

  async sendReminderEmail(
    to: string,
    roomName: string,
    startTime: Date,
    timeZone?: string,
  ) {
    if (!(await this.notificationsAllowed(to))) return;

    await this.sendEmail({
      to,
      subject: 'Your study room starts in 15 minutes',
      html: `
        <h2>${roomName}</h2>
        <p>Your study session starts at ${this.formatSchedule(startTime, timeZone)}</p>
        <p>Join now and stay consistent.</p>
        ${this.unsubscribeFooter()}
      `,
    });
  }

  async sendJoinNudgeEmail(to: string, roomName: string, joinedCount: number) {
    if (!(await this.notificationsAllowed(to))) return;

    await this.sendEmail({
      to,
      subject: `${joinedCount} students already studying`,
      html: `
        <h2>${roomName}</h2>
        <p>${joinedCount} students are already studying.</p>
        <p>Join now and do not fall behind.</p>
        ${this.unsubscribeFooter()}
      `,
    });
  }

  async sendStreakRescueEmail(to: string, name: string, streakDays: number) {
    if (!(await this.notificationsAllowed(to))) return;

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
          <a href="${this.getFrontendUrl()}" style="display:inline-block;padding:12px 28px;background:#7c3aed;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px">
            Study now →
          </a>
          <p style="color:#9aa4c7;font-size:12px;margin:24px 0 0">Even 15 minutes counts. You've got this.</p>
          ${this.unsubscribeFooter()}
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
    if (!(await this.notificationsAllowed(to))) return;

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
          <a href="${this.getFrontendUrl()}" style="display:inline-block;padding:12px 28px;background:#7c3aed;color:#fff;border-radius:10px;text-decoration:none;font-weight:600;font-size:15px">
            Keep the momentum →
          </a>
          <p style="color:#9aa4c7;font-size:12px;margin:24px 0 0">See you next week 👋</p>
          ${this.unsubscribeFooter()}
        </div>
      `,
    });
  }
}
