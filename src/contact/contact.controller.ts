import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { EmailService } from '../email/email.service';

@Controller('contact')
export class ContactController {
  constructor(private readonly email: EmailService) {}

  // Public (visitors aren't logged in) + tightly throttled against spam.
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post()
  async submit(
    @Body('name') name: string,
    @Body('email') email: string,
    @Body('subject') subject: string,
    @Body('message') message: string,
  ) {
    const n = (name || '').trim();
    const e = (email || '').trim();
    const m = (message || '').trim();
    if (!n || !m) {
      throw new BadRequestException('Name and message are required');
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) {
      throw new BadRequestException('A valid email is required');
    }
    if (m.length > 5000) {
      throw new BadRequestException('Message is too long (5000 chars max)');
    }

    await this.email.sendContactEmail({
      name: n.slice(0, 120),
      email: e.slice(0, 160),
      subject: (subject || '').slice(0, 160),
      message: m,
    });
    return { ok: true };
  }
}
