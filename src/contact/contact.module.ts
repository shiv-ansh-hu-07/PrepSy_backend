import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailService } from '../email/email.service';

@Module({
  imports: [PrismaModule], // EmailService injects PrismaService (not global)
  controllers: [ContactController],
  providers: [EmailService],
})
export class ContactModule {}
