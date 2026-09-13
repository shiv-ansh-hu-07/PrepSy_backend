import { Module } from '@nestjs/common';
import { ContactController } from './contact.controller';
import { EmailService } from '../email/email.service';

@Module({
  controllers: [ContactController],
  providers: [EmailService],
})
export class ContactModule {}
