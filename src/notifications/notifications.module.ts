import { Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailService } from '../email/email.service';

@Module({
  imports: [PrismaModule],
  providers: [NotificationsService, EmailService],
})
export class NotificationsModule {}
